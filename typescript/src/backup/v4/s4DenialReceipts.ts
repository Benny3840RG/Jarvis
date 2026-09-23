import type { Value } from "convex/values";

import type { ToolAction } from "../../actions/toolActions.js";
import {
  DEFAULT_TOOL_EXECUTION_POLICY_VERSION,
  DEFAULT_TOOL_EXECUTION_SOURCE,
  fingerprintToolAction,
  persistedDecisionReceiptIdentity,
} from "../../actions/toolExecution.js";
import { bindSafety } from "../../safety/safetyBinder.js";
import { encodeS4Payload } from "./convexCapture.js";
import type { S4ProjectNotesSource } from "./s4ProjectNotes.js";

const FIELDS = [
  "_id",
  "_creationTime",
  "ownerId",
  "receiptKey",
  "receiptId",
  "actionId",
  "requestId",
  "projectId",
  "idempotencyKey",
  "actionFingerprint",
  "tool",
  "operation",
  "actor",
  "policyVersion",
  "correlationId",
  "source",
  "status",
  "errorCode",
  "startedAt",
  "completedAt",
  "createdAt",
  "safetyBinding",
];

function exactKeys(value: object): boolean {
  return (
    Object.keys(value).length === FIELDS.length &&
    FIELDS.every((field) => Object.hasOwn(value, field))
  );
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function same(left: unknown, right: unknown): boolean {
  return encodeS4Payload(left as Value).payloadJson === encodeS4Payload(right as Value).payloadJson;
}

/**
 * Execute-phase binding for an internal, registered tool when the caller
 * granted the action's own required authority. This matches
 * `ToolExecutionService.execute` before the not-authorized decision. It is a
 * comparison input, not a new authority decision.
 */
function denialSafetyBinding(
  action: S4ProjectNotesSource["toolActions"][number],
  idempotencyKey: string,
) {
  return bindSafety({
    phase: "tool-execute",
    riskLevel: "moderate",
    domainBound: true,
    memorySafe: true,
    reliabilityHealthy: true,
    proposalSafe: true,
    toolAllowlisted: true,
    requiredAuthority: action.requiredAuthority,
    grantedAuthority: action.requiredAuthority,
    actionState: "execute",
    requiresApproval: true,
    approvalPresent: false,
    destructive: action.destructive,
    externalEffect: false,
    idempotencyKey,
    correlationId: action.requestId,
    payload: action.arguments,
    stateValid: false,
    outcome: "pending",
    recoveryAvailable: true,
  });
}

function epochMillis(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    new Date(value).getTime() === value
  );
}

/**
 * Closed denial-decision receipts for already-admitted rejected notes.create actions.
 *
 * The producer stores these under `persistDecision`, not the primary execution
 * key. Restoring one preserves that evidence. It does not install a replay hit,
 * a lease, an approval, or a reconciliation. Any other receipt shape fails closed.
 * Logical receipt keys and ids stay verbatim, so this path does not use UuidRemapper.
 */
export function validateS4DenialReceipts(source: S4ProjectNotesSource): void {
  const actions = new Map(source.toolActions.map((row) => [row.actionId, row]));
  const keys = new Set<string>();
  for (const row of source.toolExecutionReceipts) {
    const action = actions.get(row.actionId);
    if (!exactKeys(row) || !action || !text(row.idempotencyKey))
      throw new Error("Unsupported denial receipt.");
    if (
      row.projectId !== action.projectKey ||
      row.requestId !== action.requestId ||
      row.tool !== action.tool ||
      row.operation !== action.operation ||
      row.actor !== action.proposedBy ||
      row.status !== "blocked" ||
      row.errorCode !== "not-authorized" ||
      row.policyVersion !== DEFAULT_TOOL_EXECUTION_POLICY_VERSION ||
      row.source !== DEFAULT_TOOL_EXECUTION_SOURCE ||
      row.correlationId !== action.requestId
    )
      throw new Error("Unsupported denial receipt.");
    if (!epochMillis(row.startedAt) || !epochMillis(row.completedAt) || !epochMillis(row.createdAt))
      throw new Error("Unsupported denial receipt.");
    if (row.completedAt < row.startedAt) throw new Error("Unsupported denial receipt.");
    const fingerprint = fingerprintToolAction({
      actionId: action.actionId,
      projectId: action.projectKey,
      baseRevision: action.baseRevision,
      tool: action.tool,
      operation: action.operation,
      arguments: action.arguments,
      requiredAuthority: action.requiredAuthority,
      destructive: action.destructive,
    } as ToolAction);
    if (row.actionFingerprint !== fingerprint) throw new Error("Unsupported denial receipt.");
    if (!same(row.safetyBinding, denialSafetyBinding(action, row.idempotencyKey)))
      throw new Error("Unsupported denial receipt.");
    const completedAtIso = new Date(row.completedAt).toISOString();
    const identity = persistedDecisionReceiptIdentity(
      { projectId: action.projectKey, actionId: action.actionId },
      row.idempotencyKey,
      "blocked",
      completedAtIso,
    );
    if (row.receiptId !== identity.receiptId || row.receiptKey !== identity.receiptKey)
      throw new Error("Unsupported denial receipt.");
    if (keys.has(row.receiptKey)) throw new Error("Duplicate denial receipt key.");
    keys.add(row.receiptKey);
  }
}
