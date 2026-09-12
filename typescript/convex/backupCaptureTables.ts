import type { Doc } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import {
  encodeS4Payload,
  S4_TABLES,
  S4_CAPTURE_VERSION,
  S4_MAX_TOTAL_ROWS,
  type S4Table,
} from "../src/backup/v4/convexCapture.js";
import { S6_TABLES, S6_CAPTURE_VERSION, type S6Table } from "../src/backup/v4/s6MutableQuotes.js";
export type BackupTable = S4Table | S6Table;
export type CapturedTable = { table: BackupTable; documents: Doc<BackupTable>[] };
/** Owner-indexed union reader; every requested table is read once within the caller's transaction. */
export async function readBackupTables(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  tables: readonly BackupTable[],
  limit: (table: BackupTable) => number,
): Promise<CapturedTable[]> {
  const s4 = {
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
  const s6 = {
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
  const readers = { ...s4, ...s6 };
  const result: CapturedTable[] = [];
  for (const table of tables) {
    const bound = limit(table);
    const documents = await readers[table]().take(bound + 1);
    if (documents.length > bound) throw new Error("Backup table exceeds bounded read limit.");
    documents.sort(
      (a, b) => a._creationTime - b._creationTime || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0),
    );
    result.push({ table, documents });
    const s4Rows = result.filter((row) => S4_TABLES.some((value) => value === row.table));
    if (s4Rows.reduce((sum, row) => sum + row.documents.length, 0) > S4_MAX_TOTAL_ROWS)
      throw new Error("S4 capture exceeds its total row limit.");
    // Bound retained material as each table arrives; builders also check the full envelopes.
    encodeS4Payload({ tables: s4Rows });
    encodeS4Payload({
      tables: result.filter((row) => S6_TABLES.some((value) => value === row.table)),
    });
  }
  return result;
}
export function buildS4Capture(ownerId: string, capturedAt: number, rows: CapturedTable[]) {
  const tables = S4_TABLES.map((table) => {
    const entry = rows.find((row) => row.table === table);
    if (!entry || entry.documents.length > 1000) throw new Error("Invalid S4 capture table bound.");
    return entry;
  });
  const totalRows = tables.reduce((sum, row) => sum + row.documents.length, 0);
  if (totalRows > S4_MAX_TOTAL_ROWS) throw new Error("S4 capture exceeds its total row limit.");
  return {
    version: S4_CAPTURE_VERSION as typeof S4_CAPTURE_VERSION,
    provider: "convex" as const,
    ownerId,
    capturedAt,
    tableCounts: tables.map(({ table, documents }) => ({ table, rowCount: documents.length })),
    totalRows,
    ...encodeS4Payload({
      version: S4_CAPTURE_VERSION,
      provider: "convex",
      ownerId,
      capturedAt,
      tables,
    }),
    restoreVerified: false as const,
  };
}
export function buildS6Capture(
  ownerId: string,
  capturedAt: number,
  businessChecksum: string,
  rows: CapturedTable[],
) {
  if (!/^sha256:[a-f0-9]{64}$/.test(businessChecksum))
    throw new Error("Invalid business checksum.");
  const tables = S6_TABLES.map((table) => {
    const entry = rows.find((row) => row.table === table);
    if (!entry || entry.documents.length > 100) throw new Error("Invalid S6 capture table bound.");
    return entry;
  });
  return {
    ...encodeS4Payload({
      version: S6_CAPTURE_VERSION,
      provider: "convex",
      ownerId,
      capturedAt,
      businessChecksum,
      tables,
    }),
    restoreVerified: false as const,
  };
}
