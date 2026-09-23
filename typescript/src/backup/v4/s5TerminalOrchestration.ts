import { jsonToConvex } from "convex/values";

import type { Doc, Id } from "../../../convex/_generated/dataModel.js";
import { sha256Hex } from "../../actions/sha256.js";
import { encodeS4Payload } from "./convexCapture.js";

/**
 * Raw S5 inventory. Capture is not group coverage. Restore admits only the
 * terminal subset validated below.
 */
export const S5_TABLES = [
  "orchestrationRuns",
  "orchestrationSteps",
  "orchestrationReconciliations",
] as const;
export type S5Table = (typeof S5_TABLES)[number];
export const S5_CAPTURE_VERSION = "archive-v4-s5-terminal-capture:v1";
export const S5_MAX_ROWS_PER_TABLE = 100;
export const S5_MAX_TOTAL_ROWS = 300;
export const S5_MAX_PAYLOAD_BYTES = 512 * 1024;

/** Must stay identical to the producer allowlist in `orchestrationState.ts`. */
export const S5_TRIGGER_METADATA_KEYS = [
  "taskType",
  "scheduleId",
  "requestId",
  "source",
  "correlationId",
  "triggerId",
  "campaignId",
] as const;

const RUN_STATES = new Set(["succeeded", "failed"]);
const STEP_STATES = new Set(["succeeded", "failed"]);
const RECONCILIATION_STATES = new Set(["succeeded", "failed", "escalated"]);
const RECOVERY_STATES = new Set(["none", "recovered", "escalated"]);
const TRIGGER_SOURCES = new Set(["cli", "http", "mcp", "scheduler"]);
const AUTHORITIES = new Set(["T0", "T1", "T2", "T3"]);
const FAILURE_CODES = new Set([
  "blocked",
  "not_found",
  "invalid_transition",
  "unauthorised",
  "conflict",
  "invalid_request",
  "dependency_failure",
  "postcondition_failed",
  "audit_failure",
  "execution_budget_exceeded",
]);
const EVIDENCE_KINDS = new Set(["checkpoint", "restart", "retry", "indeterminate"]);

export type S5EncodedCapture = { payloadJson: string; payloadSha256: string };
export type S5TerminalSource = { ownerId: string } & {
  [Table in S5Table]: Doc<Table>[];
};
export type S5TerminalIdentities = {
  [Table in S5Table]: Array<{
    sourceId: string;
    targetId: Id<Table>;
    sourceCreationTime: number;
  }>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function logical(value: unknown, max = 200): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim()
  );
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function whole(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function triggerPayload(value: unknown): boolean {
  if (!record(value)) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      (S5_TRIGGER_METADATA_KEYS as readonly string[]).includes(key) &&
      (typeof item === "string"
        ? item.length <= 4_000
        : typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))),
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/** Closed terminal history only. Live, retryable, and unclassified rows are refused. */
export function readS5TerminalOrchestration(capture: S5EncodedCapture): S5TerminalSource {
  if (new TextEncoder().encode(capture.payloadJson).length > S5_MAX_PAYLOAD_BYTES)
    throw new Error("S5 payload byte limit exceeded.");
  if (sha256Hex(capture.payloadJson) !== capture.payloadSha256)
    throw new Error("S5 capture checksum mismatch.");
  const decoded = jsonToConvex(JSON.parse(capture.payloadJson));
  if (encodeS4Payload(decoded).payloadJson !== capture.payloadJson)
    throw new Error("S5 capture is not canonical.");
  if (
    !record(decoded) ||
    !exactKeys(decoded, ["version", "provider", "ownerId", "capturedAt", "tables"]) ||
    decoded.version !== S5_CAPTURE_VERSION ||
    decoded.provider !== "convex" ||
    typeof decoded.ownerId !== "string" ||
    !decoded.ownerId ||
    typeof decoded.capturedAt !== "number" ||
    !Number.isFinite(decoded.capturedAt) ||
    !Array.isArray(decoded.tables) ||
    decoded.tables.length !== S5_TABLES.length
  )
    throw new Error("Invalid S5 capture envelope or inventory.");

  const result: S5TerminalSource = {
    ownerId: decoded.ownerId,
    orchestrationRuns: [],
    orchestrationSteps: [],
    orchestrationReconciliations: [],
  };
  let totalRows = 0;
  for (let index = 0; index < S5_TABLES.length; index++) {
    const table = S5_TABLES[index]!;
    const entry = decoded.tables[index];
    if (
      !record(entry) ||
      !exactKeys(entry, ["table", "documents"]) ||
      entry.table !== table ||
      !Array.isArray(entry.documents) ||
      entry.documents.length > S5_MAX_ROWS_PER_TABLE
    )
      throw new Error("Invalid S5 table inventory or row bound.");
    totalRows += entry.documents.length;
    if (totalRows > S5_MAX_TOTAL_ROWS) throw new Error("S5 capture total row limit exceeded.");
    const ids = new Set<string>();
    let previous: { time: number; id: string } | undefined;
    for (const row of entry.documents) {
      if (
        !record(row) ||
        typeof row._id !== "string" ||
        !row._id ||
        !finite(row._creationTime) ||
        row.ownerId !== decoded.ownerId
      )
        throw new Error("Invalid S5 source identity or owner.");
      if (ids.has(row._id)) throw new Error("Duplicate S5 physical identity.");
      ids.add(row._id);
      if (
        previous &&
        (row._creationTime < previous.time ||
          (row._creationTime === previous.time && row._id < previous.id))
      )
        throw new Error("Invalid S5 source ordering.");
      previous = { time: row._creationTime, id: row._id };
    }
    if (table === "orchestrationRuns")
      result.orchestrationRuns = entry.documents as Doc<"orchestrationRuns">[];
    else if (table === "orchestrationSteps")
      result.orchestrationSteps = entry.documents as Doc<"orchestrationSteps">[];
    else
      result.orchestrationReconciliations =
        entry.documents as Doc<"orchestrationReconciliations">[];
  }
  validateTerminalGraph(result);
  return result;
}

function validateTerminalGraph(source: S5TerminalSource): void {
  const runs = new Map<string, Doc<"orchestrationRuns">>();
  const idempotency = new Set<string>();
  for (const run of source.orchestrationRuns) {
    if (
      !logical(run.runId) ||
      !logical(run.triggerId) ||
      !TRIGGER_SOURCES.has(run.triggerSource) ||
      !logical(run.triggerKind) ||
      !logical(run.idempotencyKey) ||
      !logical(run.requestFingerprint) ||
      !logical(run.planFingerprint) ||
      !triggerPayload(run.triggerPayload) ||
      !AUTHORITIES.has(run.authority) ||
      !logical(run.policyVersion) ||
      !logical(run.policyFingerprint) ||
      !Array.isArray(run.nodeIds) ||
      run.nodeIds.length < 1 ||
      run.nodeIds.length > 100 ||
      !run.nodeIds.every((nodeId) => logical(nodeId)) ||
      new Set(run.nodeIds).size !== run.nodeIds.length ||
      !Array.isArray(run.completedStepIds) ||
      !run.completedStepIds.every((nodeId) => run.nodeIds.includes(nodeId)) ||
      new Set(run.completedStepIds).size !== run.completedStepIds.length ||
      !whole(run.checkpointSequence, 0, Number.MAX_SAFE_INTEGER) ||
      !RUN_STATES.has(run.state) ||
      !whole(run.retryCount, 0, 5) ||
      !whole(run.maxRetries, 0, 5) ||
      run.retryCount > run.maxRetries ||
      !RECOVERY_STATES.has(run.recoveryState) ||
      !finite(run.createdAt) ||
      !finite(run.updatedAt) ||
      run.updatedAt < run.createdAt
    )
      throw new Error("Unsupported or invalid terminal orchestration run.");
    if (run.state === "failed" && !FAILURE_CODES.has(run.failureCode ?? ""))
      throw new Error("Failed orchestration run is missing its failure code.");
    if (run.state === "succeeded" && run.failureCode !== undefined)
      throw new Error("Succeeded orchestration run carries a failure code.");
    if (!Array.isArray(run.recoveryEvidence) || run.recoveryEvidence.length > 20)
      throw new Error("Orchestration recovery evidence is unclassified.");
    for (const item of run.recoveryEvidence) {
      if (
        !record(item) ||
        !EVIDENCE_KINDS.has(item.kind) ||
        !logical(item.detail, 4_000) ||
        !finite(item.occurredAt)
      )
        throw new Error("Orchestration recovery evidence is unclassified.");
    }
    if (
      (run.checkpointNodeId !== undefined && !run.nodeIds.includes(run.checkpointNodeId)) ||
      (run.checkpointAt !== undefined && !finite(run.checkpointAt))
    )
      throw new Error("Orchestration checkpoint does not resolve to a captured node.");
    if (runs.has(run.runId) || idempotency.has(`${run.triggerSource}\0${run.idempotencyKey}`))
      throw new Error("Duplicate orchestration run identity.");
    runs.set(run.runId, run);
    idempotency.add(`${run.triggerSource}\0${run.idempotencyKey}`);
  }

  const steps = new Map<string, Doc<"orchestrationSteps">>();
  const stepsByRun = new Map<string, Doc<"orchestrationSteps">[]>();
  for (const step of source.orchestrationSteps) {
    const run = runs.get(step.runId);
    if (!run || !run.nodeIds.includes(step.nodeId))
      throw new Error("Unresolved orchestration step reference.");
    if (
      !STEP_STATES.has(step.state) ||
      step.retryable !== false ||
      !whole(step.attempt, 1, Number.MAX_SAFE_INTEGER) ||
      !logical(step.operationId) ||
      !finite(step.updatedAt) ||
      !finite(step.completedAt) ||
      step.leaseOwner !== undefined ||
      step.leaseToken !== undefined ||
      step.leaseExpiresAt !== undefined
    )
      throw new Error(
        step.retryable
          ? "Retryable orchestration steps are unsupported."
          : step.leaseOwner !== undefined ||
              step.leaseToken !== undefined ||
              step.leaseExpiresAt !== undefined
            ? "Live orchestration lease is unsupported."
            : "Unsupported or invalid terminal orchestration step.",
      );
    if (
      step.leaseFencingToken !== undefined &&
      !whole(step.leaseFencingToken, 1, Number.MAX_SAFE_INTEGER)
    )
      throw new Error("Invalid orchestration fencing history.");
    if (step.state === "failed" && !FAILURE_CODES.has(step.failureCode ?? ""))
      throw new Error("Failed orchestration step is missing its failure code.");
    if (step.state === "succeeded" && step.failureCode !== undefined)
      throw new Error("Succeeded orchestration step carries a failure code.");
    if (step.state === "succeeded" && !run.completedStepIds.includes(step.nodeId))
      throw new Error("Succeeded orchestration step is missing from the run checkpoint.");
    if (step.state === "failed" && run.completedStepIds.includes(step.nodeId))
      throw new Error("Failed orchestration step is recorded as completed.");
    const key = `${step.runId}\0${step.nodeId}`;
    if (steps.has(key)) throw new Error("Duplicate orchestration step identity.");
    steps.set(key, step);
    const group = stepsByRun.get(step.runId) ?? [];
    group.push(step);
    stepsByRun.set(step.runId, group);
  }
  for (const run of runs.values()) {
    const group = stepsByRun.get(run.runId) ?? [];
    if (
      !sameSet(
        group.map((step) => step.nodeId),
        run.nodeIds,
      )
    )
      throw new Error("Orchestration run nodes do not match captured steps.");
    const succeeded = group.filter((step) => step.state === "succeeded").map((step) => step.nodeId);
    if (!sameSet(succeeded, run.completedStepIds))
      throw new Error("Orchestration completed steps do not match succeeded nodes.");
    if (group.some((step) => step.state === "failed") && run.state !== "failed")
      throw new Error("A failed orchestration step requires a failed run.");
    if (group.every((step) => step.state === "succeeded") && run.state !== "succeeded")
      throw new Error("Succeeded orchestration steps require a succeeded run.");
  }

  const reconciliations = new Map<string, Doc<"orchestrationReconciliations">>();
  for (const row of source.orchestrationReconciliations) {
    const step = steps.get(`${row.runId}\0${row.nodeId}`);
    if (
      !step ||
      !logical(row.reconciliationId) ||
      !logical(row.operationId) ||
      !logical(row.effectFingerprint) ||
      !logical(row.provider) ||
      !logical(row.providerCorrelationId) ||
      row.attempt !== step.attempt ||
      row.operationId !== step.operationId ||
      !RECONCILIATION_STATES.has(row.state) ||
      !finite(row.createdAt) ||
      !finite(row.updatedAt) ||
      row.updatedAt < row.createdAt
    )
      throw new Error(
        row.state === "pending"
          ? "Pending orchestration reconciliation is unsupported."
          : "Unresolved or invalid orchestration reconciliation.",
      );
    if (row.state === "failed" && !FAILURE_CODES.has(row.failureCode ?? ""))
      throw new Error("Failed orchestration reconciliation is missing its failure code.");
    if (reconciliations.has(row.reconciliationId))
      throw new Error("Duplicate orchestration reconciliation identity.");
    reconciliations.set(row.reconciliationId, row);
  }
  for (const step of source.orchestrationSteps) {
    if (step.reconciliationId === undefined) continue;
    const row = reconciliations.get(step.reconciliationId);
    if (!row || row.runId !== step.runId || row.nodeId !== step.nodeId)
      throw new Error("Orchestration step reconciliation does not resolve.");
  }
  for (const run of source.orchestrationRuns) {
    if (run.recoveryReference === undefined) continue;
    const row = reconciliations.get(run.recoveryReference);
    if (!row || row.runId !== run.runId)
      throw new Error("Orchestration recovery reference does not resolve.");
  }
}
