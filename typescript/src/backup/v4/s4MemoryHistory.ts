import {
  normalizeMemoryRecords,
  assertUniqueMeasurementKeys,
} from "../../../convex/memoryChangeSetLogic.js";
import { encodeS4Payload } from "./convexCapture.js";
import type { S4ProjectNotesSource } from "./s4ProjectNotes.js";

const KINDS = new Set(["fact", "assumption", "measurement", "decision"]);
const key = (project: string, id: string) => JSON.stringify([project, id]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function logical(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function fields(value: Record<string, unknown>, names: string[]): boolean {
  return (
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
  );
}

/** Closed, non-actionable memory history only; existing table schemas validate storage values. */
export function validateS4MemoryHistory(source: S4ProjectNotesSource): void {
  const projects = new Map(source.projects.map((row) => [row.projectKey, row]));
  const records = new Map<string, (typeof source.projectRecords)[number]>();
  const groups = new Map<string, number>();
  for (const row of source.projectRecords) {
    if (
      !projects.has(row.projectKey) ||
      !logical(row.recordId) ||
      !KINDS.has(row.kind) ||
      row.record.kind !== row.kind ||
      row.record.recordId !== row.recordId
    )
      throw new Error("Unsupported or inconsistent project memory record reference.");
    const identity = key(row.projectKey, row.recordId);
    if (records.has(identity)) throw new Error("Duplicate project record logical identity.");
    records.set(identity, row);
    const group = key(row.projectKey, row.kind);
    const count = (groups.get(group) ?? 0) + 1;
    groups.set(group, count);
    if (count > 100) throw new Error("Project record group exceeds ordinary read limit of 100.");
  }
  const changes = new Map<string, (typeof source.memoryChangeSets)[number]>();
  for (const row of source.memoryChangeSets) {
    const project = projects.get(row.projectKey);
    if (
      !project ||
      !logical(row.changeSetId) ||
      !logical(row.requestId) ||
      changes.has(row.changeSetId)
    )
      throw new Error("Invalid or duplicate memory change set project reference.");
    if (row.state !== "applied" && row.state !== "rejected")
      throw new Error(
        "Only terminal memory change sets may be restored; actionable history is unsupported.",
      );
    if (
      !positive(row.baseRevision) ||
      row.baseRevision > project.revision ||
      !Number.isFinite(row.createdAt) ||
      !Number.isFinite(row.updatedAt)
    )
      throw new Error("Invalid memory change set revision or timestamp.");
    const normalized = normalizeMemoryRecords(row.records);
    assertUniqueMeasurementKeys(normalized);
    if (encodeS4Payload(normalized).payloadJson !== encodeS4Payload(row.records).payloadJson)
      throw new Error("Memory definitions do not match their canonical producer values.");
    const ids = new Set<string>();
    for (const record of row.records) {
      if (!KINDS.has(record.kind) || !logical(record.recordId) || ids.has(record.recordId))
        throw new Error("Invalid or duplicate memory definition identity.");
      ids.add(record.recordId);
      if (row.state === "applied" && !records.has(key(row.projectKey, record.recordId)))
        throw new Error("Applied memory record reference is missing.");
    }
    if (
      row.state === "applied" &&
      (row.appliedRevision !== row.baseRevision + 1 ||
        row.appliedRevision > project.revision ||
        row.approvedBy !== "user" ||
        !Number.isFinite(row.approvedAt) ||
        !Number.isFinite(row.appliedAt) ||
        row.appliedAt !== row.updatedAt ||
        row.rejectedBy !== undefined ||
        row.rejectedAt !== undefined ||
        row.rejectedReason !== undefined)
    )
      throw new Error("Invalid applied memory history revision or terminal timestamp.");
    if (
      row.state === "rejected" &&
      (row.rejectedBy !== "user" ||
        !Number.isFinite(row.rejectedAt) ||
        row.rejectedAt !== row.updatedAt ||
        typeof row.rejectedReason !== "string" ||
        row.appliedAt !== undefined ||
        row.appliedRevision !== undefined ||
        ((row.approvedBy !== undefined || row.approvedAt !== undefined) &&
          (row.approvedBy !== "user" || !Number.isFinite(row.approvedAt))))
    )
      throw new Error("Invalid rejected memory history.");
    changes.set(row.changeSetId, row);
  }
  const histories = new Map<string, Set<string>>();
  const requestCounts = new Map<string, number>();
  for (const event of source.auditEvents) {
    const id = event.payload.changeSetId;
    const change = typeof id === "string" ? changes.get(id) : undefined;
    if (!change || event.scopeKey !== change.projectKey || event.requestId !== change.requestId)
      throw new Error("Audit change set reference does not resolve.");
    const seen = histories.get(change.changeSetId) ?? new Set<string>();
    histories.set(change.changeSetId, seen);
    if (seen.has(event.eventType)) throw new Error("Duplicate memory audit history event.");
    seen.add(event.eventType);
    const count = (requestCounts.get(change.requestId) ?? 0) + 1;
    requestCounts.set(change.requestId, count);
    if (count > 100) throw new Error("Audit request exceeds ordinary read limit of 100.");
    const recordIds = change.records.map((record) => record.recordId);
    const payload = event.payload;
    if (event.eventType === "memory.change_set.proposed") {
      if (
        !fields(payload, ["changeSetId", "baseRevision", "recordCount", "recordIds"]) ||
        payload.baseRevision !== change.baseRevision ||
        payload.recordCount !== recordIds.length ||
        !same(payload.recordIds, recordIds) ||
        event.actor !== change.proposedBy ||
        event.createdAt !== change.createdAt
      )
        throw new Error("Invalid proposed memory audit history.");
    } else if (event.eventType === "memory.change_set.approved") {
      if (
        !fields(payload, ["changeSetId", "baseRevision"]) ||
        payload.baseRevision !== change.baseRevision ||
        event.actor !== "user" ||
        event.createdAt !== change.approvedAt
      )
        throw new Error("Invalid approved memory audit history.");
    } else if (event.eventType === "memory.change_set.applied") {
      if (
        change.state !== "applied" ||
        !fields(payload, ["changeSetId", "baseRevision", "appliedRevision", "recordIds"]) ||
        payload.baseRevision !== change.baseRevision ||
        payload.appliedRevision !== change.appliedRevision ||
        !same(payload.recordIds, recordIds) ||
        event.actor !== "user" ||
        event.createdAt !== change.appliedAt
      )
        throw new Error("Invalid applied memory audit history.");
    } else if (event.eventType === "memory.change_set.rejected") {
      if (
        change.state !== "rejected" ||
        !fields(payload, ["changeSetId", "reason"]) ||
        payload.reason !== change.rejectedReason ||
        event.actor !== "user" ||
        event.createdAt !== change.rejectedAt
      )
        throw new Error("Invalid rejected memory audit history.");
    } else throw new Error("Unsupported audit event producer.");
  }
  for (const row of changes.values()) {
    const events = histories.get(row.changeSetId) ?? new Set<string>();
    if (
      !events.has("memory.change_set.proposed") ||
      !events.has(`memory.change_set.${row.state}`) ||
      (row.state === "applied" && !events.has("memory.change_set.approved")) ||
      (row.approvedAt !== undefined && !events.has("memory.change_set.approved"))
    )
      throw new Error("Memory change set audit history is incomplete.");
  }
  // The shared lossless codec, not plain JSON, owns preservation of tagged values.
  encodeS4Payload({
    projectRecords: source.projectRecords,
    memoryChangeSets: source.memoryChangeSets,
    auditEvents: source.auditEvents,
  });
}
