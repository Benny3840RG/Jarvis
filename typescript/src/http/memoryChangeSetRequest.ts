import type {
  MemoryChangeSetActor,
  MemoryChangeSetState,
  MemoryRecord,
} from "../memory/memoryChangeSets.js";

const CHANGE_SET_STATES: readonly MemoryChangeSetState[] = [
  "proposed",
  "approved",
  "rejected",
  "applied",
];
const CHANGE_SET_ACTORS: readonly MemoryChangeSetActor[] = ["user", "agent", "tool"];
const MAX_RECORDS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

function memoryRecord(value: unknown): MemoryRecord {
  if (!isRecord(value)) throw new Error("Memory record must be an object.");
  const kind = requiredString(value.kind, "Memory record kind");
  const recordId = requiredString(value.recordId, "Memory record ID");

  switch (kind) {
    case "fact": {
      const source = requiredString(value.source, `Fact ${recordId} source`);
      if (!["user", "file", "tool", "measurement", "inference"].includes(source)) {
        throw new Error(`Fact ${recordId} source is not supported.`);
      }
      return {
        kind,
        recordId,
        statement: requiredString(value.statement, `Fact ${recordId} statement`),
        source: source as "user" | "file" | "tool" | "measurement" | "inference",
        confidence: finiteNumber(value.confidence, `Fact ${recordId} confidence`),
        recordedAt: requiredString(value.recordedAt, `Fact ${recordId} recordedAt`),
      };
    }
    case "assumption": {
      const status = requiredString(value.status, `Assumption ${recordId} status`);
      const impact = requiredString(value.impact, `Assumption ${recordId} impact`);
      if (!["unverified", "verified", "rejected"].includes(status)) {
        throw new Error(`Assumption ${recordId} status is not supported.`);
      }
      if (!["low", "medium", "high"].includes(impact)) {
        throw new Error(`Assumption ${recordId} impact is not supported.`);
      }
      return {
        kind,
        recordId,
        statement: requiredString(value.statement, `Assumption ${recordId} statement`),
        status: status as "unverified" | "verified" | "rejected",
        impact: impact as "low" | "medium" | "high",
      };
    }
    case "measurement":
      return {
        kind,
        recordId,
        name: requiredString(value.name, `Measurement ${recordId} name`),
        value: finiteNumber(value.value, `Measurement ${recordId} value`),
        unit: requiredString(value.unit, `Measurement ${recordId} unit`),
        ...(value.tolerance === undefined
          ? {}
          : { tolerance: requiredString(value.tolerance, `Measurement ${recordId} tolerance`) }),
        source: requiredString(value.source, `Measurement ${recordId} source`),
      };
    case "decision":
      return {
        kind,
        recordId,
        decision: requiredString(value.decision, `Decision ${recordId} decision`),
        rationale: requiredString(value.rationale, `Decision ${recordId} rationale`),
        alternativesRejected: stringArray(
          value.alternativesRejected,
          `Decision ${recordId} alternativesRejected`,
        ),
        timestamp: requiredString(value.timestamp, `Decision ${recordId} timestamp`),
      };
    default:
      throw new Error(`Memory record kind ${kind} is not supported.`);
  }
}

export function parseStageMemoryChangeSet(body: unknown): {
  changeSetId: string;
  expectedRevision: number;
  records: MemoryRecord[];
  rationale: string;
  proposedBy: MemoryChangeSetActor;
} {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > MAX_RECORDS) {
    throw new Error(`records must contain between 1 and ${MAX_RECORDS} items.`);
  }
  const proposedBy = requiredString(body.proposedBy, "proposedBy");
  if (!CHANGE_SET_ACTORS.includes(proposedBy as MemoryChangeSetActor)) {
    throw new Error("proposedBy is not supported.");
  }
  return {
    changeSetId: requiredString(body.changeSetId, "changeSetId"),
    expectedRevision: positiveInteger(body.expectedRevision, "expectedRevision"),
    records: body.records.map(memoryRecord),
    rationale: requiredString(body.rationale, "rationale"),
    proposedBy: proposedBy as MemoryChangeSetActor,
  };
}

export function parseExpectedRevision(body: unknown): number {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  return positiveInteger(body.expectedRevision, "expectedRevision");
}

export function parseRejectionReason(body: unknown): string {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  return requiredString(body.reason, "reason");
}

export function parseMemoryChangeSetState(value: unknown): MemoryChangeSetState | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CHANGE_SET_STATES.includes(value as MemoryChangeSetState)) {
    throw new Error("state is not supported.");
  }
  return value as MemoryChangeSetState;
}

export function parseListLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("limit must be an integer between 1 and 100.");
  }
  return parsed;
}
