import { v } from "convex/values";
import { query } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { requireOwner, requireApprovalToken } from "./authHelpers.js";
import { encodeS4Payload } from "../src/backup/v4/convexCapture.js";
import { S6_CAPTURE_VERSION, S6_TABLES, type S6Table } from "../src/backup/v4/s6MutableQuotes.js";

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
    const readers = {
      quotes: () =>
        ctx.db.query("quotes").withIndex("by_owner_and_quote_id", (q) => q.eq("ownerId", ownerId)),
      quoteRevisions: () =>
        ctx.db
          .query("quoteRevisions")
          .withIndex("by_owner_quote_and_revision", (q) => q.eq("ownerId", ownerId)),
      quotePdfArtifacts: () =>
        ctx.db
          .query("quotePdfArtifacts")
          .withIndex("by_owner_quote_and_revision", (q) => q.eq("ownerId", ownerId)),
      quoteDeliveryAttempts: () =>
        ctx.db
          .query("quoteDeliveryAttempts")
          .withIndex("by_owner_and_delivery_attempt_id", (q) => q.eq("ownerId", ownerId)),
      quoteMigrationRecords: () =>
        ctx.db
          .query("quoteMigrationRecords")
          .withIndex("by_owner_and_source_key", (q) => q.eq("ownerId", ownerId)),
      toolActions: () =>
        ctx.db
          .query("toolActions")
          .withIndex("by_owner_and_action_id", (q) => q.eq("ownerId", ownerId)),
      toolExecutionReceipts: () =>
        ctx.db
          .query("toolExecutionReceipts")
          .withIndex("by_owner_and_receipt_key", (q) => q.eq("ownerId", ownerId)),
      externalReconciliations: () =>
        ctx.db
          .query("externalReconciliations")
          .withIndex("by_owner_and_reconciliation_id", (q) => q.eq("ownerId", ownerId)),
    };
    const tables: Array<{ table: S6Table; documents: Doc<S6Table>[] }> = [];
    const capturedAt = Date.now();
    for (const table of S6_TABLES) {
      const documents = await readers[table]().take(101);
      if (documents.length > 100) throw new Error("S6 table exceeds bounded capture limit.");
      documents.sort((a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id));
      tables.push({ table, documents });
    }
    return {
      ...encodeS4Payload({
        version: S6_CAPTURE_VERSION,
        provider: "convex",
        ownerId,
        capturedAt,
        businessChecksum: args.businessChecksum,
        tables,
      }),
      restoreVerified: false as const,
    };
  },
});
