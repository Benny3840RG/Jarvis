import { readBackupTables, buildS4Capture, buildS6Capture } from "./backupCaptureTables.js";
import { S6_TABLES } from "../src/backup/v4/s6MutableQuotes.js";
import { v } from "convex/values";
import { requireApprovalToken, requireOwner } from "./authHelpers.js";
import { query } from "./_generated/server.js";
import { S4_CAPTURE_VERSION, S4_TABLES } from "../src/backup/v4/convexCapture.js";

/** Read-only, one-transaction raw S4 material; no restore or archive-sealing authority. */
export const capture = query({
  args: { serviceToken: v.string(), approvalToken: v.string() },
  returns: v.object({
    version: v.literal(S4_CAPTURE_VERSION),
    provider: v.literal("convex"),
    ownerId: v.string(),
    capturedAt: v.number(),
    tableCounts: v.array(v.object({ table: v.string(), rowCount: v.number() })),
    totalRows: v.number(),
    payloadJson: v.string(),
    payloadSha256: v.string(),
    restoreVerified: v.literal(false),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken);
    return buildS4Capture(
      ownerId,
      Date.now(),
      await readBackupTables(ctx, ownerId, S4_TABLES, () => 1000),
    );
  },
});

/** One provider-consistent capture of the supported-domain union; no restore/sealing authority. */
export const captureJoint = query({
  args: { serviceToken: v.string(), approvalToken: v.string(), businessChecksum: v.string() },
  returns: v.object({
    s4: v.object({ payloadJson: v.string(), payloadSha256: v.string() }),
    s6: v.object({ payloadJson: v.string(), payloadSha256: v.string() }),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken);
    if (!/^sha256:[a-f0-9]{64}$/.test(args.businessChecksum))
      throw new Error("Invalid business checksum.");
    const capturedAt = Date.now();
    const tables = [
      ...S4_TABLES,
      ...S6_TABLES.filter((table) => !S4_TABLES.some((value) => value === table)),
    ];
    const rows = await readBackupTables(ctx, ownerId, tables, (table) =>
      S6_TABLES.some((value) => value === table) ? 100 : 1000,
    );
    const s4 = buildS4Capture(ownerId, capturedAt, rows),
      s6 = buildS6Capture(ownerId, capturedAt, args.businessChecksum, rows);
    return {
      s4: { payloadJson: s4.payloadJson, payloadSha256: s4.payloadSha256 },
      s6: { payloadJson: s6.payloadJson, payloadSha256: s6.payloadSha256 },
    };
  },
});
