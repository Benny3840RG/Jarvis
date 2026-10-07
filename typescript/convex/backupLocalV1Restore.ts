import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { sha256HexBytes } from "../src/actions/sha256.js";
import { S4_MAX_PAYLOAD_BYTES } from "../src/backup/v4/convexCapture.js";
import {
  LOCAL_V1_DIRECT_CREATE_TOMBSTONE_NOTE,
  LOCAL_V1_RECEIPT_TABLES,
  type LocalV1ReceiptTable,
} from "../src/backup/v4/localV1Receipts.js";
import { S6_TABLES, type S6Table } from "../src/backup/v4/s6MutableQuotes.js";
import { requireApprovalToken, requireOwner } from "./authHelpers.js";
import type { Id, TableNames } from "./_generated/dataModel.js";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;

const mapValidator = v.array(v.object({ sourceId: v.string(), targetId: v.string() }));

const resultValidator = v.object({
  tasks: mapValidator,
  reminders: mapValidator,
  builds: mapValidator,
  pdfs: v.array(v.object({ reference: v.string(), storageId: v.string(), digest: v.string() })),
});

type IdMap = { sourceId: string; targetId: string };
type PdfRef = { reference: string; storageId: string; digest: string };
type RestoreResult = {
  tasks: IdMap[];
  reminders: IdMap[];
  builds: IdMap[];
  pdfs: PdfRef[];
};

type Row = Record<string, unknown>;

type Prepared = {
  state: Row;
  tasks: Row[];
  reminders: Row[];
  builds: Row[];
  buildLogs: Row[];
  upgrades: Row[];
  assets: Row[];
  preferences: Row[];
  tables: Record<S6Table | LocalV1ReceiptTable, Row[]>;
  tombstones: Row[];
  clientIds: Set<string>;
  projectIds: Set<string>;
  flatQuoteIds: Set<string>;
  invoiceQuoteIds: string[];
};

const insertIsolatedRef = makeFunctionReference<
  "mutation",
  {
    serviceToken: string;
    approvalToken: string;
    now: number;
    payloadJson: string;
    pdfs: PdfRef[];
  },
  RestoreResult
>("backupLocalV1Restore:insertIsolated");

function object(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function rows(value: unknown, label: string): Row[] {
  if (!Array.isArray(value)) throw new Error(`Local V1 restore is missing ${label}.`);
  return value.map((row, index) => {
    if (!object(row)) throw new Error(`Local V1 restore ${label}[${index}] is not a document.`);
    return row;
  });
}

function tablesOf(value: unknown, expected: readonly string[], label: string): Map<string, Row[]> {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`Local V1 restore omitted a ${label} table.`);
  }
  const found = new Map<string, Row[]>();
  for (let index = 0; index < expected.length; index += 1) {
    const entry = value[index];
    const name = expected[index] ?? "";
    if (!object(entry) || entry.table !== name || !Array.isArray(entry.documents)) {
      throw new Error(`Local V1 restore omitted required table ${name}.`);
    }
    found.set(name, rows(entry.documents, name));
  }
  return found;
}

function idList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Local V1 restore is missing ${label}.`);
  }
  return value as string[];
}

/** Fail closed before any insert. Does not admit an executable approval or a resumable send. */
export function prepareLocalV1Restore(payloadJson: string, now: number): Prepared {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch (error: unknown) {
    throw new Error("Local V1 restore payload is not valid JSON.", { cause: error });
  }
  if (
    !object(parsed) ||
    !object(parsed.core) ||
    !object(parsed.memory) ||
    !object(parsed.business)
  ) {
    throw new Error("Local V1 restore payload is missing a group.");
  }
  if (!object(parsed.core.state)) throw new Error("Local V1 restore is missing assistant state.");
  const s6 = tablesOf(parsed.s6, S6_TABLES, "S6");
  const receipts = tablesOf(parsed.receipts, LOCAL_V1_RECEIPT_TABLES, "receipt");
  const quotes = s6.get("quotes") ?? [];
  const revisions = s6.get("quoteRevisions") ?? [];
  const artifacts = s6.get("quotePdfArtifacts") ?? [];
  const quoteIds = new Set(quotes.map((row) => row.quoteId).filter(text));
  const revisionIds = new Set(revisions.map((row) => row.revisionId).filter(text));
  if (quoteIds.size !== quotes.length || revisionIds.size !== revisions.length) {
    throw new Error("Local V1 restore quote identity is missing or duplicated.");
  }
  for (const quote of quotes) {
    if (!text(quote.currentRevisionId) || !revisionIds.has(quote.currentRevisionId)) {
      throw new Error("Local V1 restore quote has no current revision.");
    }
  }
  for (const revision of revisions) {
    if (!text(revision.quoteId) || !quoteIds.has(revision.quoteId)) {
      throw new Error("Local V1 restore revision does not belong to a quote.");
    }
    if (
      revision.status === "finalized" &&
      (!text(revision.fingerprint) || typeof revision.finalizedAt !== "number")
    ) {
      throw new Error("Local V1 restore finalized revision is missing its fingerprint.");
    }
  }
  for (const artifact of artifacts) {
    if (
      !text(artifact._id) ||
      !text(artifact.revisionId) ||
      !revisionIds.has(artifact.revisionId)
    ) {
      throw new Error("Local V1 restore PDF artifact does not match a revision.");
    }
    if (!text(artifact.digest) || typeof artifact.byteLength !== "number") {
      throw new Error("Local V1 restore PDF artifact is missing its digest.");
    }
  }
  const reconciliations = s6.get("externalReconciliations") ?? [];
  const receiptRows = s6.get("toolExecutionReceipts") ?? [];
  const receiptKeys = new Map(receiptRows.map((row) => [row.receiptKey, row]));
  const reconciliationIds = new Set<string>();
  for (const row of reconciliations) {
    if (
      row.state !== "resolved" ||
      (row.terminalStatus !== "succeeded" && row.terminalStatus !== "failed") ||
      !text(row.reconciliationId) ||
      !text(row.receiptKey)
    ) {
      throw new Error("Local V1 restore reconciliation is not terminal evidence.");
    }
    if (
      row.leaseOwner !== undefined ||
      row.leaseToken !== undefined ||
      row.leaseExpiresAt !== undefined
    ) {
      throw new Error("Local V1 restore refuses a live reconciliation lease.");
    }
    const receipt = receiptKeys.get(row.receiptKey);
    if (!receipt || (receipt.status !== "succeeded" && receipt.status !== "failed")) {
      throw new Error("Local V1 restore reconciliation has no terminal receipt.");
    }
    if (receipt.effectFingerprint !== row.effectFingerprint) {
      throw new Error("Local V1 restore receipt does not match its reconciliation.");
    }
    reconciliationIds.add(row.reconciliationId);
  }
  const terminalDelivery = new Set(["succeeded", "failed", "reconciled"]);
  for (const delivery of s6.get("quoteDeliveryAttempts") ?? []) {
    if (!text(delivery.reconciliationId) || !reconciliationIds.has(delivery.reconciliationId)) {
      throw new Error("Local V1 restore delivery does not match a reconciliation.");
    }
    if (typeof delivery.status !== "string" || !terminalDelivery.has(delivery.status)) {
      throw new Error("Local V1 restore delivery is not terminal evidence.");
    }
  }
  for (const actionRow of s6.get("toolActions") ?? []) {
    if (actionRow.state !== "approved") continue;
    if (
      actionRow.approvalExpiryPolicy !== "ttl" ||
      typeof actionRow.approvalExpiresAt !== "number" ||
      actionRow.approvalExpiresAt > now
    ) {
      throw new Error("Restored tool action would be executable.");
    }
  }
  const clientIds = new Set(idList(parsed.business.clientIds, "client ids"));
  const projectIds = new Set(idList(parsed.business.projectIds, "project ids"));
  const flatQuoteIds = new Set(idList(parsed.business.flatQuoteIds, "flat quote ids"));
  for (const quote of quotes) {
    if (!text(quote.clientId) || !clientIds.has(quote.clientId)) {
      throw new Error("Local V1 restore quote client is not in the business archive.");
    }
    if (
      quote.projectId !== undefined &&
      (!text(quote.projectId) || !projectIds.has(quote.projectId))
    ) {
      throw new Error("Local V1 restore quote project is not in the business archive.");
    }
  }
  const invoiceQuoteIds = idList(parsed.business.invoiceQuoteIds, "invoice quote ids");
  for (const quoteId of invoiceQuoteIds) {
    if (!flatQuoteIds.has(quoteId) && !quoteIds.has(quoteId)) {
      throw new Error(`Local V1 restore invoice quote ${quoteId} matches neither store.`);
    }
  }
  const tables = {} as Prepared["tables"];
  for (const table of S6_TABLES) tables[table] = s6.get(table) ?? [];
  for (const table of LOCAL_V1_RECEIPT_TABLES) tables[table] = receipts.get(table) ?? [];
  const tasks = rows(parsed.core.tasks, "tasks");
  const reminders = rows(parsed.core.reminders, "reminders");
  const tombstones = directCreateTombstones(parsed.receiptTombstones);
  planDirectCreateReceipts(tasks, reminders, tables.directCreateReceipts, tombstones);
  return {
    state: parsed.core.state,
    tasks,
    reminders,
    builds: rows(parsed.memory.builds, "builds"),
    buildLogs: rows(parsed.memory.buildLogs, "build logs"),
    upgrades: rows(parsed.memory.upgrades, "upgrades"),
    assets: rows(parsed.memory.assets, "assets"),
    preferences: rows(parsed.memory.preferences, "preferences"),
    tables,
    tombstones,
    clientIds,
    projectIds,
    flatQuoteIds,
    invoiceQuoteIds,
  };
}

function directCreateTombstones(value: unknown): Row[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Local V1 restore direct-create tombstones are invalid.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (
      !object(entry) ||
      entry.table !== "directCreateReceipts" ||
      (entry.entityType !== "task" && entry.entityType !== "reminder") ||
      !text(entry.entityId) ||
      !text(entry.idempotencyKey) ||
      entry.note !== LOCAL_V1_DIRECT_CREATE_TOMBSTONE_NOTE
    ) {
      throw new Error(`Local V1 restore direct-create tombstones are invalid at ${index}.`);
    }
    const key = `${entry.entityType}\0${entry.entityId}\0${entry.idempotencyKey}`;
    if (seen.has(key)) {
      throw new Error("Local V1 restore direct-create tombstones are invalid.");
    }
    seen.add(key);
    return entry;
  });
}

type ReceiptPlan = { entityId: string; tombstoned: boolean };

function planDirectCreateReceipts(
  tasks: Row[],
  reminders: Row[],
  receipts: Row[],
  tombstones: Row[],
): ReceiptPlan[] {
  const taskRows = sourceRows(tasks, "task");
  const reminderRows = sourceRows(reminders, "reminder");
  const captured = new Set<string>([...taskRows.keys(), ...reminderRows.keys()]);
  const byKey = new Map<string, Row>();
  for (const tombstone of tombstones) {
    const entityId = String(tombstone.entityId);
    if (captured.has(entityId)) {
      throw new Error("Local V1 restore direct-create tombstone names a captured entity.");
    }
    byKey.set(
      `${String(tombstone.entityType)}\0${entityId}\0${String(tombstone.idempotencyKey)}`,
      tombstone,
    );
  }
  const consumed = new Set<string>();
  const plan = receipts.map((row) => {
    const entityType = row.entityType;
    const entityId = row.entityId;
    if ((entityType !== "task" && entityType !== "reminder") || !text(entityId)) {
      throw new Error("Local V1 restore direct-create receipt has no entity.");
    }
    const own = entityType === "task" ? taskRows : reminderRows;
    const other = entityType === "task" ? reminderRows : taskRows;
    const entity = own.get(entityId);
    if (entity) {
      assertReceiptMatchesEntity(entity, row);
      return { entityId, tombstoned: false };
    }
    if (other.has(entityId)) {
      throw new Error("Local V1 restore direct-create receipt has no entity.");
    }
    const key = `${entityType}\0${entityId}\0${String(row.idempotencyKey)}`;
    if (!byKey.has(key) || consumed.has(key)) {
      throw new Error("Local V1 restore direct-create receipt has no entity.");
    }
    consumed.add(key);
    return { entityId, tombstoned: true };
  });
  if (consumed.size !== byKey.size) {
    throw new Error("Local V1 restore direct-create tombstone does not match a receipt.");
  }
  return plan;
}

function sourceRows(rows: Row[], label: string): Map<string, Row> {
  const found = new Map<string, Row>();
  for (const row of rows) {
    const id = sourceId(row, label);
    if (found.has(id)) throw new Error(`Local V1 restore duplicate ${label} source id.`);
    found.set(id, row);
  }
  return found;
}

function assertReceiptMatchesEntity(entity: Row, receipt: Row): void {
  const key = entity.directCreateIdempotencyKey;
  const fingerprint = entity.directCreateFingerprint;
  if ((key === undefined) !== (fingerprint === undefined)) {
    throw new Error(
      "Local V1 restore direct-create identity must include both the key and the fingerprint.",
    );
  }
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    typeof fingerprint !== "string" ||
    fingerprint.length === 0 ||
    key !== receipt.idempotencyKey ||
    fingerprint !== receipt.requestFingerprint
  ) {
    throw new Error("Local V1 restore direct-create receipt does not match its entity.");
  }
}

const LOCAL_OWNER_ID = "jarvis-cli";

function storedFields(row: Row): Row {
  const fields = { ...row };
  delete fields._id;
  delete fields._creationTime;
  return fields;
}

/** Same local owner builds and assets already use. A foreign archive owner must not hide a receipt or quote. */
function localOwnerFields(row: Row): Row {
  return { ...storedFields(row), ownerId: LOCAL_OWNER_ID };
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Local V1 restore ${key} is invalid.`);
  }
  return value;
}

function optionalNumber(row: Row, key: string): number | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Local V1 restore ${key} is invalid.`);
  }
  return value;
}

function optionalStrings(row: Row, key: string): string[] | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`Local V1 restore ${key} is invalid.`);
  }
  return value as string[];
}

function copiedOptionals(
  row: Row,
  keys: { text?: string[]; number?: string[]; strings?: string[] },
): Row {
  const out: Row = {};
  for (const key of keys.text ?? []) {
    const value = optionalText(row, key);
    if (value !== undefined) out[key] = value;
  }
  for (const key of keys.number ?? []) {
    const value = optionalNumber(row, key);
    if (value !== undefined) out[key] = value;
  }
  for (const key of keys.strings ?? []) {
    const value = optionalStrings(row, key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function directCreateInsert(row: Row): Row {
  const key = optionalText(row, "directCreateIdempotencyKey");
  const fingerprint = optionalText(row, "directCreateFingerprint");
  if ((key === undefined) !== (fingerprint === undefined)) {
    throw new Error(
      "Local V1 restore direct-create identity must include both the key and the fingerprint.",
    );
  }
  return {
    ...copiedOptionals(row, { text: ["projectId"], number: ["updatedAt", "revision"] }),
    ...(key === undefined
      ? {}
      : { directCreateIdempotencyKey: key, directCreateFingerprint: fingerprint }),
  };
}

function sourceId(row: Row, label: string): string {
  const id = row.id ?? row._id;
  if (!text(id)) throw new Error(`Local V1 restore ${label} is missing its source id.`);
  return id;
}

function remap(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remap(item, ids));
  if (!object(value)) return value;
  const out: Row = {};
  for (const [key, item] of Object.entries(value)) out[key] = remap(item, ids);
  return out;
}

async function assertEmpty(ctx: MutationCtx): Promise<void> {
  for (const table of Object.keys(schema.tables) as TableNames[]) {
    if ((await ctx.db.query(table).take(1)).length > 0) {
      throw new Error("Local V1 restore requires an empty database.");
    }
  }
}

async function insert(ctx: MutationCtx, table: TableNames, fields: Row): Promise<string> {
  return await ctx.db.insert(table, fields as never);
}

/**
 * Empty-database apply for one Local V1 capture. Not the draft-only S6 helper.
 * Copies approval expiry verbatim and refuses an approval that is still executable.
 * Returned id maps are tasks, reminders, and builds. Build logs and upgrades
 * are inserted against the remapped build id. Assets and preferences are
 * inserted with their fields and are not included in those maps.
 */
export const insertIsolated = internalMutation({
  args: {
    serviceToken: v.string(),
    approvalToken: v.string(),
    now: v.number(),
    payloadJson: v.string(),
    pdfs: v.array(v.object({ reference: v.string(), storageId: v.string(), digest: v.string() })),
  },
  returns: resultValidator,
  handler: async (ctx, args): Promise<RestoreResult> => {
    requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken);
    if (!Number.isSafeInteger(args.now) || args.now < 0) {
      throw new Error("Invalid Local V1 restore clock.");
    }
    const prepared = prepareLocalV1Restore(args.payloadJson, args.now);
    await assertEmpty(ctx);
    const pdfByReference = new Map(args.pdfs.map((pdf) => [pdf.reference, pdf]));
    const artifacts = prepared.tables.quotePdfArtifacts;
    if (pdfByReference.size !== artifacts.length) {
      throw new Error("PDF bytes are missing for a captured artifact.");
    }

    const taskIds = new Map<string, string>();
    const reminderIds = new Map<string, string>();
    const buildIds = new Map<string, string>();
    const tasks: IdMap[] = [];
    const reminders: IdMap[] = [];
    const builds: IdMap[] = [];

    for (const row of prepared.tasks) {
      const source = sourceId(row, "task");
      const targetId = await insert(ctx, "tasks", {
        ownerId: LOCAL_OWNER_ID,
        title: row.title,
        completed: row.completed,
        category: row.category,
        ...directCreateInsert(row),
        createdAt: row.createdAt,
      });
      taskIds.set(source, targetId);
      tasks.push({ sourceId: source, targetId });
    }
    for (const row of prepared.reminders) {
      const source = sourceId(row, "reminder");
      const legacyDue = optionalText(row, "due");
      const targetId = await insert(ctx, "reminders", {
        ownerId: LOCAL_OWNER_ID,
        title: row.title,
        ...(legacyDue === undefined ? {} : { due: legacyDue }),
        ...(row.dueRaw === undefined ? {} : { dueRaw: row.dueRaw }),
        ...(row.dueAt === undefined ? {} : { dueAt: row.dueAt, dueTimezone: row.dueTimezone }),
        ...directCreateInsert(row),
        createdAt: row.createdAt,
      });
      reminderIds.set(source, targetId);
      reminders.push({ sourceId: source, targetId });
    }
    for (const row of prepared.builds) {
      const source = sourceId(row, "build");
      const targetId = await insert(ctx, "builds", {
        ownerId: LOCAL_OWNER_ID,
        name: row.name,
        kind: row.kind,
        status: row.status,
        ...copiedOptionals(row, { text: ["description", "nickname", "notes"] }),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
      buildIds.set(source, targetId);
      builds.push({ sourceId: source, targetId });
    }
    const ids = new Map([...taskIds, ...reminderIds, ...buildIds]);
    await insert(ctx, "assistantState", {
      ownerId: LOCAL_OWNER_ID,
      key: "primary",
      state: remap(prepared.state, ids),
      updatedAt: typeof prepared.state.updatedAt === "number" ? prepared.state.updatedAt : args.now,
    });
    for (const row of prepared.buildLogs) {
      const buildId = buildIds.get(String(row.buildId));
      if (buildId === undefined) throw new Error("Local V1 restore build log has no build.");
      await insert(ctx, "buildLogs", {
        ownerId: LOCAL_OWNER_ID,
        buildId,
        kind: row.kind,
        title: row.title,
        ...copiedOptionals(row, { text: ["body"], number: ["occurredAt", "updatedAt"] }),
        createdAt: row.createdAt,
      });
    }
    for (const row of prepared.upgrades) {
      const buildId = buildIds.get(String(row.buildId));
      if (buildId === undefined) throw new Error("Local V1 restore upgrade has no build.");
      await insert(ctx, "upgrades", {
        ownerId: LOCAL_OWNER_ID,
        buildId,
        title: row.title,
        ...copiedOptionals(row, {
          text: ["reason", "beforeState", "afterState", "outcome", "version"],
          strings: ["parts"],
          number: ["occurredAt", "updatedAt"],
        }),
        createdAt: row.createdAt,
      });
    }
    for (const row of prepared.assets) {
      await insert(ctx, "assets", {
        ownerId: LOCAL_OWNER_ID,
        name: row.name,
        kind: row.kind,
        ...copiedOptionals(row, {
          text: ["notes"],
          number: ["serviceIntervalDays", "lastServicedAt"],
        }),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    for (const row of prepared.preferences) {
      await insert(ctx, "preferences", {
        ownerId: LOCAL_OWNER_ID,
        key: row.key,
        value: row.value,
        ...copiedOptionals(row, { text: ["category"] }),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    for (const row of prepared.tables.quotes) await insert(ctx, "quotes", localOwnerFields(row));
    for (const row of prepared.tables.quoteRevisions) {
      await insert(ctx, "quoteRevisions", localOwnerFields(row));
    }
    const pdfs: PdfRef[] = [];
    for (const artifact of artifacts) {
      const reference = `quotePdfArtifacts/${String(artifact._id)}`;
      const pdf = pdfByReference.get(reference);
      if (!pdf || pdf.digest !== artifact.digest) {
        throw new Error(`PDF bytes are missing for ${reference}.`);
      }
      const fields = localOwnerFields(artifact);
      delete fields.storageId;
      await insert(ctx, "quotePdfArtifacts", {
        ...fields,
        storageId: pdf.storageId as Id<"_storage">,
      });
      pdfs.push(pdf);
    }
    for (const table of ["quoteDeliveryAttempts", "quoteMigrationRecords"] as const) {
      for (const row of prepared.tables[table]) await insert(ctx, table, localOwnerFields(row));
    }
    for (const table of [
      "toolActions",
      "toolExecutionReceipts",
      "externalReconciliations",
    ] as const) {
      for (const row of prepared.tables[table]) await insert(ctx, table, storedFields(row));
    }
    const receiptPlan = planDirectCreateReceipts(
      prepared.tasks,
      prepared.reminders,
      prepared.tables.directCreateReceipts,
      prepared.tombstones,
    );
    for (const [index, row] of prepared.tables.directCreateReceipts.entries()) {
      const step = receiptPlan[index];
      const targetId = step?.tombstoned
        ? step.entityId
        : (row.entityType === "task" ? taskIds : reminderIds).get(String(row.entityId));
      if (targetId === undefined)
        throw new Error("Local V1 restore direct-create receipt has no entity.");
      const fields = localOwnerFields(row);
      await insert(ctx, "directCreateReceipts", { ...fields, entityId: targetId });
    }
    for (const row of prepared.tables.internalActionResults) {
      const targetId = (row.entityType === "task" ? taskIds : reminderIds).get(
        String(row.entityId),
      );
      if (targetId === undefined)
        throw new Error("Local V1 restore internal action result has no entity.");
      const fields = storedFields(row);
      const result = object(fields.result) ? { ...fields.result } : undefined;
      if (!result || result.id !== row.entityId) {
        throw new Error("Local V1 restore internal action result id does not match its entity.");
      }
      result.id = targetId;
      await insert(ctx, "internalActionResults", { ...fields, entityId: targetId, result });
    }
    return { tasks, reminders, builds, pdfs };
  },
});

/**
 * Stores PDF bytes, checks the digest against the bytes just stored, then
 * applies documents. A failed apply deletes the blobs it stored.
 */
export const restoreLocalV1 = internalAction({
  args: {
    serviceToken: v.string(),
    approvalToken: v.string(),
    now: v.number(),
    payloadJson: v.string(),
    blobs: v.array(v.object({ reference: v.string(), bytes: v.bytes() })),
  },
  returns: resultValidator,
  handler: async (ctx, args): Promise<RestoreResult> => {
    requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken);
    const prepared = prepareLocalV1Restore(args.payloadJson, args.now);
    const byReference = new Map<string, ArrayBuffer>();
    for (const blob of args.blobs) {
      if (byReference.has(blob.reference)) throw new Error("Local V1 PDF blob index is invalid.");
      byReference.set(blob.reference, blob.bytes);
    }
    const stored: Array<Id<"_storage">> = [];
    try {
      const pdfs: PdfRef[] = [];
      for (const artifact of prepared.tables.quotePdfArtifacts) {
        const reference = `quotePdfArtifacts/${String(artifact._id)}`;
        const bytes = byReference.get(reference);
        if (!bytes) throw new Error(`PDF bytes are missing for ${reference}.`);
        const view = new Uint8Array(bytes);
        if (view.byteLength !== artifact.byteLength || view.byteLength > S4_MAX_PAYLOAD_BYTES) {
          throw new Error("PDF byte length does not match the artifact.");
        }
        const hex = sha256HexBytes(view);
        const digest = `quote-pdf:v1:sha256:${hex}`;
        if (artifact.digest !== digest || !DIGEST.test(`sha256:${hex}`)) {
          throw new Error("PDF digest does not match stored bytes.");
        }
        const storageId = await ctx.storage.store(new Blob([bytes], { type: "application/pdf" }));
        stored.push(storageId);
        const roundTrip = await ctx.storage.get(storageId);
        if (roundTrip === null) throw new Error(`PDF bytes are missing for ${reference}.`);
        const got = new Uint8Array(await roundTrip.arrayBuffer());
        if (sha256HexBytes(got) !== hex) throw new Error("PDF digest does not match stored bytes.");
        pdfs.push({ reference, storageId, digest });
      }
      if (pdfs.length !== byReference.size)
        throw new Error("PDF bytes are missing for a captured artifact.");
      return await ctx.runMutation(insertIsolatedRef, {
        serviceToken: args.serviceToken,
        approvalToken: args.approvalToken,
        now: args.now,
        payloadJson: args.payloadJson,
        pdfs,
      });
    } catch (error: unknown) {
      for (const storageId of stored) await ctx.storage.delete(storageId);
      throw error;
    }
  },
});
