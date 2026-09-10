import { v } from "convex/values";
import { collectBounded, requireApprovalToken, requireOwner } from "./authHelpers.js";
import type { Doc } from "./_generated/dataModel.js";
import { query } from "./_generated/server.js";
import {
  encodeS4Payload,
  S4_CAPTURE_VERSION,
  S4_MAX_TOTAL_ROWS,
  S4_TABLES,
  type S4Table,
} from "../src/backup/v4/convexCapture.js";

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
    const readers = {
      projects: () =>
        ctx.db
          .query("projects")
          .withIndex("by_owner_and_project_key", (q) => q.eq("ownerId", ownerId)),
      projectRecords: () =>
        ctx.db
          .query("projectRecords")
          .withIndex("by_owner_and_project_key_and_kind", (q) => q.eq("ownerId", ownerId)),
      notes: () =>
        ctx.db
          .query("notes")
          .withIndex("by_owner_and_project_and_updated_at", (q) => q.eq("ownerId", ownerId)),
      developmentEvents: () =>
        ctx.db
          .query("developmentEvents")
          .withIndex("by_owner_and_subject_id_and_created_at", (q) => q.eq("ownerId", ownerId)),
      developmentSubjects: () =>
        ctx.db
          .query("developmentSubjects")
          .withIndex("by_owner_and_updated_at", (q) => q.eq("ownerId", ownerId)),
      runtimeEvents: () =>
        ctx.db
          .query("runtimeEvents")
          .withIndex("by_owner_and_created_at", (q) => q.eq("ownerId", ownerId)),
      toolActions: () =>
        ctx.db
          .query("toolActions")
          .withIndex("by_owner_and_action_id", (q) => q.eq("ownerId", ownerId)),
      toolExecutionReceipts: () =>
        ctx.db
          .query("toolExecutionReceipts")
          .withIndex("by_owner_and_receipt_key", (q) => q.eq("ownerId", ownerId)),
      memoryChangeSets: () =>
        ctx.db
          .query("memoryChangeSets")
          .withIndex("by_owner_and_change_set_id", (q) => q.eq("ownerId", ownerId)),
      auditEvents: () =>
        ctx.db
          .query("auditEvents")
          .withIndex("by_owner_and_created_at", (q) => q.eq("ownerId", ownerId)),
      validationReports: () =>
        ctx.db
          .query("validationReports")
          .withIndex("by_owner_and_request_id", (q) => q.eq("ownerId", ownerId)),
      externalReconciliations: () =>
        ctx.db
          .query("externalReconciliations")
          .withIndex("by_owner_and_reconciliation_id", (q) => q.eq("ownerId", ownerId)),
      omegaMissions: () =>
        ctx.db
          .query("omegaMissions")
          .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId)),
      omegaActionContracts: () =>
        ctx.db
          .query("omegaActionContracts")
          .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId)),
      omegaEvidence: () =>
        ctx.db
          .query("omegaEvidence")
          .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId)),
      omegaValidationProofs: () =>
        ctx.db
          .query("omegaValidationProofs")
          .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId)),
      omegaContradictionResolutions: () =>
        ctx.db
          .query("omegaContradictionResolutions")
          .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId)),
    };
    const tables: { table: S4Table; documents: Doc<S4Table>[] }[] = [];
    let totalRows = 0;
    const capturedAt = Date.now();
    let encoded = encodeS4Payload({
      version: S4_CAPTURE_VERSION,
      provider: "convex",
      ownerId,
      capturedAt,
      tables,
    });
    for (const table of S4_TABLES) {
      const documents = await collectBounded<Doc<S4Table>>(readers[table](), `S4 ${table}`);
      totalRows += documents.length;
      if (totalRows > S4_MAX_TOTAL_ROWS) throw new Error("S4 capture exceeds its total row limit.");
      documents.sort(
        (a, b) => a._creationTime - b._creationTime || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0),
      );
      tables.push({ table, documents });
      encoded = encodeS4Payload({
        version: S4_CAPTURE_VERSION,
        provider: "convex",
        ownerId,
        capturedAt,
        tables,
      });
    }
    return {
      version: S4_CAPTURE_VERSION as typeof S4_CAPTURE_VERSION,
      provider: "convex" as const,
      ownerId,
      capturedAt,
      tableCounts: tables.map(({ table, documents }) => ({ table, rowCount: documents.length })),
      totalRows,
      ...encoded,
      restoreVerified: false as const,
    };
  },
});
