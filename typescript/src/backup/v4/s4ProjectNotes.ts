import { jsonToConvex } from "convex/values";
import { validateS4MemoryHistory } from "./s4MemoryHistory.js";
import type { Doc, Id } from "../../../convex/_generated/dataModel.js";
import { sha256Hex } from "../../actions/sha256.js";
import {
  encodeS4Payload,
  S4_CAPTURE_VERSION,
  S4_MAX_PAYLOAD_BYTES,
  S4_MAX_TOTAL_ROWS,
  S4_TABLES,
} from "./convexCapture.js";

export type S4EncodedCapture = { payloadJson: string; payloadSha256: string };
export const S4_RESTORE_TABLES = [
  "projects",
  "projectRecords",
  "notes",
  "memoryChangeSets",
  "auditEvents",
] as const;
export type S4RestoreTable = (typeof S4_RESTORE_TABLES)[number];
export type S4ProjectNotesSource = { ownerId: string } & {
  [Table in S4RestoreTable]: Doc<Table>[];
};
export type S4ProjectNotesIdentities = {
  [Table in S4RestoreTable]: Array<{
    sourceId: string;
    targetId: Id<Table>;
    sourceCreationTime: number;
  }>;
};
function supported(table: string): table is S4RestoreTable {
  return S4_RESTORE_TABLES.some((value) => value === table);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
/** Strict capture-envelope and closed-graph preflight. Table schemas remain Convex's authority. */
export function readS4ProjectNotes(capture: S4EncodedCapture): S4ProjectNotesSource {
  if (new TextEncoder().encode(capture.payloadJson).length > S4_MAX_PAYLOAD_BYTES)
    throw new Error("S4 payload byte limit exceeded.");
  if (sha256Hex(capture.payloadJson) !== capture.payloadSha256)
    throw new Error("S4 capture checksum mismatch.");
  const decoded = jsonToConvex(JSON.parse(capture.payloadJson));
  if (encodeS4Payload(decoded).payloadJson !== capture.payloadJson)
    throw new Error("S4 capture is not canonical.");
  if (
    !record(decoded) ||
    !exactKeys(decoded, ["version", "provider", "ownerId", "capturedAt", "tables"]) ||
    decoded.version !== S4_CAPTURE_VERSION ||
    decoded.provider !== "convex" ||
    typeof decoded.ownerId !== "string" ||
    !decoded.ownerId ||
    typeof decoded.capturedAt !== "number" ||
    !Number.isFinite(decoded.capturedAt) ||
    !Array.isArray(decoded.tables) ||
    decoded.tables.length !== S4_TABLES.length
  )
    throw new Error("Invalid S4 capture envelope or inventory.");
  const result: S4ProjectNotesSource = {
    ownerId: decoded.ownerId,
    projects: [],
    notes: [],
    projectRecords: [],
    memoryChangeSets: [],
    auditEvents: [],
  };
  let totalRows = 0;
  for (let index = 0; index < S4_TABLES.length; index++) {
    const table = S4_TABLES[index];
    const entry = decoded.tables[index];
    if (
      !record(entry) ||
      !exactKeys(entry, ["table", "documents"]) ||
      entry.table !== table ||
      !Array.isArray(entry.documents) ||
      entry.documents.length > 1000
    )
      throw new Error("Invalid S4 table inventory or row bound.");
    totalRows += entry.documents.length;
    if (totalRows > S4_MAX_TOTAL_ROWS) throw new Error("S4 capture total row limit exceeded.");
    if (!supported(table)) {
      if (entry.documents.length) throw new Error(`Unsupported nonempty S4 table: ${table}.`);
      continue;
    }
    const ids = new Set<string>();
    let previous: { time: number; id: string } | undefined;
    for (const row of entry.documents) {
      if (
        !record(row) ||
        typeof row._id !== "string" ||
        !row._id ||
        typeof row._creationTime !== "number" ||
        !Number.isFinite(row._creationTime) ||
        row.ownerId !== decoded.ownerId
      )
        throw new Error("Invalid S4 source identity or owner.");
      if (ids.has(row._id)) throw new Error("Duplicate S4 physical identity.");
      ids.add(row._id);
      if (
        previous &&
        (row._creationTime < previous.time ||
          (row._creationTime === previous.time && row._id < previous.id))
      )
        throw new Error("Invalid S4 source ordering.");
      previous = { time: row._creationTime, id: row._id };
    }
    if (table === "projects") result.projects = entry.documents as Doc<"projects">[];
    else if (table === "notes") result.notes = entry.documents as Doc<"notes">[];
    else if (table === "projectRecords")
      result.projectRecords = entry.documents as Doc<"projectRecords">[];
    else if (table === "memoryChangeSets")
      result.memoryChangeSets = entry.documents as Doc<"memoryChangeSets">[];
    else result.auditEvents = entry.documents as Doc<"auditEvents">[];
  }
  const projects = new Set<string>();
  for (const row of result.projects) {
    if (
      typeof row.projectKey !== "string" ||
      !row.projectKey ||
      row.projectKey !== row.projectKey.trim() ||
      projects.has(row.projectKey)
    )
      throw new Error("Invalid or duplicate project logical key.");
    projects.add(row.projectKey);
  }
  const receipts = new Set<string>();
  for (const row of result.notes) {
    if (typeof row.projectId !== "string" || !projects.has(row.projectId))
      throw new Error("Unresolved notes.projectId project reference.");
    if (
      typeof row.idempotencyKey !== "string" ||
      !row.idempotencyKey ||
      row.idempotencyKey !== row.idempotencyKey.trim()
    )
      throw new Error("Invalid note idempotency key.");
    const key = JSON.stringify([row.projectId, row.idempotencyKey]);
    if (receipts.has(key)) throw new Error("Duplicate note idempotency scope.");
    receipts.add(key);
  }
  validateS4MemoryHistory(result);
  return result;
}
