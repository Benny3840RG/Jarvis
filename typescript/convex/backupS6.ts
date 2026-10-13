import {
  readBackupTables,
  buildS6Capture,
  buildLocalV1ReceiptCapture,
} from "./backupCaptureTables.js";
import { v } from "convex/values";
import { action, query, type QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { requireOwner, requireApprovalToken } from "./authHelpers.js";
import { sha256HexBytes } from "../src/actions/sha256.js";
import { S4_MAX_PAYLOAD_BYTES } from "../src/backup/v4/convexCapture.js";
import {
  LOCAL_V1_DIRECT_CREATE_TOMBSTONE_NOTE,
  LOCAL_V1_RECEIPT_ROW_CAP,
  LOCAL_V1_RECEIPT_TABLES,
  type LocalV1DirectCreateTombstone,
} from "../src/backup/v4/localV1Receipts.js";
import { S6_TABLES } from "../src/backup/v4/s6MutableQuotes.js";

/** Provider-consistent raw material; the supplied S3 digest is an archive binding, not filesystem proof. */
export const capture = query({
  args: { serviceToken: v.string(), approvalToken: v.string(), businessChecksum: v.string() },
  returns: v.object({
    payloadJson: v.string(),
    payloadSha256: v.string(),
    restoreVerified: v.literal(false),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken);
    if (!/^sha256:[a-f0-9]{64}$/.test(args.businessChecksum))
      throw new Error("Invalid business checksum.");
    return buildS6Capture(
      ownerId,
      Date.now(),
      args.businessChecksum,
      await readBackupTables(ctx, ownerId, S6_TABLES, () => 100),
    );
  },
});

/**
 * Read-only Local V1 Convex inventory: the existing S6 tables plus task and
 * reminder idempotency rows. PDF bytes are read by `readLocalV1Blobs`.
 * `quoteAggregate` stays unsealed. Overflow aborts at the S6 caps.
 */
export const captureLocalV1 = query({
  args: {
    serviceToken: v.string(),
    approvalToken: v.string(),
    businessChecksum: v.string(),
    capturedAt: v.number(),
  },
  returns: v.object({
    s6: v.object({
      payloadJson: v.string(),
      payloadSha256: v.string(),
      restoreVerified: v.literal(false),
    }),
    receipts: v.object({
      payloadJson: v.string(),
      payloadSha256: v.string(),
    }),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken);
    if (!Number.isSafeInteger(args.capturedAt) || args.capturedAt < 0) {
      throw new Error("Invalid Local V1 capture clock.");
    }
    const s6Rows = await readBackupTables(ctx, ownerId, S6_TABLES, () => 100);
    const receiptRows = await readBackupTables(ctx, ownerId, LOCAL_V1_RECEIPT_TABLES, () => {
      return LOCAL_V1_RECEIPT_ROW_CAP;
    });
    if (!s6Rows.some((row) => row.table === "quotePdfArtifacts")) {
      throw new Error("Missing S6 table quotePdfArtifacts.");
    }
    return {
      s6: buildS6Capture(ownerId, args.capturedAt, args.businessChecksum, s6Rows),
      receipts: buildLocalV1ReceiptCapture(
        ownerId,
        args.capturedAt,
        receiptRows,
        await directCreateTombstones(ctx, ownerId, receiptRows),
      ),
    };
  },
});

async function directCreateTombstones(
  ctx: QueryCtx,
  ownerId: string,
  rows: Awaited<ReturnType<typeof readBackupTables>>,
): Promise<LocalV1DirectCreateTombstone[]> {
  const receipts = rows.find((row) => row.table === "directCreateReceipts");
  const tombstones: LocalV1DirectCreateTombstone[] = [];
  for (const doc of receipts?.documents ?? []) {
    const receipt = directCreateReceipt(doc);
    if (!receipt) throw new Error("Local V1 direct-create receipt has no entity.");
    const table = receipt.entityType === "task" ? "tasks" : "reminders";
    const id = ctx.db.normalizeId(table, receipt.entityId);
    const entity = id === null ? null : await ctx.db.get(table, id);
    if (entity && entity.ownerId === ownerId) continue;
    tombstones.push({
      table: "directCreateReceipts",
      entityType: receipt.entityType,
      entityId: receipt.entityId,
      idempotencyKey: receipt.idempotencyKey,
      note: LOCAL_V1_DIRECT_CREATE_TOMBSTONE_NOTE,
    });
  }
  return tombstones;
}

function directCreateReceipt(doc: object): {
  entityType: "task" | "reminder";
  entityId: string;
  idempotencyKey: string;
} | null {
  if (!("entityType" in doc) || !("entityId" in doc) || !("idempotencyKey" in doc)) return null;
  const { entityType, entityId, idempotencyKey } = doc;
  if (
    (entityType !== "task" && entityType !== "reminder") ||
    typeof entityId !== "string" ||
    typeof idempotencyKey !== "string"
  ) {
    return null;
  }
  return { entityType, entityId, idempotencyKey };
}

const blobRequestValidator = v.object({
  reference: v.string(),
  storageId: v.string(),
  byteLength: v.number(),
});

/**
 * Reads `_storage` bytes for artifacts already listed by `captureLocalV1`.
 * It does not insert, patch, or delete.
 */
export const readLocalV1Blobs = action({
  args: {
    serviceToken: v.string(),
    approvalToken: v.string(),
    blobs: v.array(blobRequestValidator),
  },
  returns: v.array(
    v.object({
      reference: v.string(),
      digest: v.string(),
      byteLength: v.number(),
      bytes: v.bytes(),
    }),
  ),
  handler: async (ctx, args) => {
    requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken);
    if (args.blobs.length > 100) throw new Error("Backup table exceeds bounded read limit.");
    const blobs = [];
    for (const request of args.blobs) {
      if (request.byteLength > S4_MAX_PAYLOAD_BYTES) {
        throw new Error("S6 capture exceeds its payload byte limit.");
      }
      const stored = await ctx.storage.get(request.storageId as Id<"_storage">);
      if (stored === null) throw new Error(`PDF bytes are missing for ${request.reference}.`);
      const bytes = new Uint8Array(await stored.arrayBuffer());
      if (bytes.byteLength !== request.byteLength || bytes.byteLength > S4_MAX_PAYLOAD_BYTES) {
        throw new Error("PDF byte length does not match the artifact.");
      }
      const hex = sha256HexBytes(bytes);
      blobs.push({
        reference: request.reference,
        digest: `sha256:${hex}`,
        byteLength: bytes.byteLength,
        bytes: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      });
    }
    return blobs;
  },
});
