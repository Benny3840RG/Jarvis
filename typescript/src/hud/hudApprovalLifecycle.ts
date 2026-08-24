import type { ToolAction, ToolActionState } from "../actions/toolActions.js";
import type { ToolExecutionMode, ToolExecutionStatus } from "../actions/toolExecution.js";
import type { ExternalReconciliationState } from "../reconciliation/externalReconciliation.js";

/**
 * HUD presentation of the governed path:
 * proposal → inspection → approval → execution → receipt → reconciliation.
 *
 * These are display stages, not a second ToolAction state machine.
 * ToolAction remains proposed | approved | rejected | expired | revoked.
 * Execution remains a separate receipt. Reconciliation remains a separate record.
 */
export const HUD_APPROVAL_STAGES = [
  "awaiting_inspection",
  "inspection_failed",
  "awaiting_approval",
  "awaiting_commissioning",
  "approval_accepted",
  "awaiting_execution",
  "executing",
  "receipt_received",
  "reconciliation_pending",
  "reconciled",
  "execution_failed",
  "execution_blocked",
  "outcome_unknown",
  "rejected",
  "expired",
  "stale",
] as const;

export type HudApprovalStage = (typeof HUD_APPROVAL_STAGES)[number];

export type HudInspectionState =
  "empty" | "loading" | "ready" | "error" | "not-found" | "not-required";

export type HudApprovalActionView = Pick<
  ToolAction,
  "state" | "isApprovalExpired" | "approvalExpiresAt" | "operation" | "tool"
> & {
  arguments?: Record<string, unknown>;
};

export type HudReceiptObservation = {
  status: ToolExecutionStatus;
  executionMode?: ToolExecutionMode;
};

export type HudReconciliationObservation = {
  state: ExternalReconciliationState;
  terminalStatus?: "succeeded" | "failed";
} | null;

export type HudApprovalLifecycleInput = {
  action: HudApprovalActionView | null;
  inspection: {
    required: boolean;
    state: HudInspectionState;
  };
  /**
   * True only when an authoritative receipt list read succeeded for this action.
   * Missing observation is UNKNOWN, not FAILED.
   */
  receiptAvailable?: boolean;
  /** @deprecated Prefer `receipts`. A single receipt is treated as one observation. */
  receipt?: HudReceiptObservation | null;
  receipts?: readonly HudReceiptObservation[];
  reconciliationAvailable?: boolean;
  reconciliation?: HudReconciliationObservation;
  /** Runtime-emitted in-flight execution. Do not invent this from missing data. */
  executionInFlight?: boolean;
  /** False while quote-delivery / quotes:send remains uncommissioned. */
  quoteDeliveryCommissioned?: boolean;
  now?: number;
};

export const HUD_APPROVAL_STAGE_LABELS: Record<HudApprovalStage, string> = {
  awaiting_inspection: "AWAITING INSPECTION",
  inspection_failed: "QUOTE COULD NOT BE VERIFIED",
  awaiting_approval: "AWAITING APPROVAL",
  awaiting_commissioning: "AWAITING COMMISSIONING",
  approval_accepted: "APPROVAL ACCEPTED",
  awaiting_execution: "AWAITING EXECUTION",
  executing: "EXECUTING",
  receipt_received: "RECEIPT RECEIVED",
  reconciliation_pending: "RECONCILIATION PENDING",
  reconciled: "RECONCILED",
  execution_failed: "EXECUTION FAILED",
  execution_blocked: "EXECUTION BLOCKED",
  outcome_unknown: "OUTCOME UNKNOWN",
  rejected: "REJECTED",
  expired: "EXPIRED",
  stale: "STALE PROPOSAL",
};

export const COMPLETE_TASK_SEMANTICS = {
  tool: "complete_task",
  http: "POST /api/v1/tasks/{taskId}/complete",
  mutatesDurableTask: true,
  approvesQuote: false,
  sendsQuote: false,
  executesToolAction: false,
  requiresConfirmation: true,
  confirmationIsAuthorisationBoundary: false,
  hideBesideAwaitingApproval: true,
  confirmationCopy:
    "HUD COMPLETE TASK confirmation protects against accidental interactive activation only. It does not constitute an authorisation boundary. The existing complete_task MCP capability retains its current authority. This does not approve or send a quote.",
} as const;

export const HUD_APPROVAL_OPERATOR_PATH = {
  inspectProposal: "GET /api/v1/projects/{projectId}/tool-actions/{actionId}",
  inspectQuote: "GET /api/v1/quotes/{quoteId}",
  inspectReceipts: "GET /api/v1/projects/{projectId}/tool-actions/{actionId}/receipts",
  approve: "POST /api/v1/projects/{projectId}/tool-actions/{actionId}/approve",
  reject: "POST /api/v1/projects/{projectId}/tool-actions/{actionId}/reject",
  execute: "POST /api/v1/projects/{projectId}/tool-actions/{actionId}/execute",
  approvalCredential: "JARVIS_APPROVAL_TOKEN",
  widgetMayStoreApprovalToken: false,
  widgetMayCallApprove: false,
  widgetMayCallExecute: false,
} as const;

export function inspectionRequiredFor(action: HudApprovalActionView | null): boolean {
  if (!action) return false;
  const quoteId = action.arguments && action.arguments.quoteId;
  return Boolean(
    quoteId || /quote/i.test(action.tool || "") || /quotes?:send/i.test(action.operation || ""),
  );
}

export function isQuoteSend(action: HudApprovalActionView | null): boolean {
  return Boolean(action && /quotes?:send/i.test(action.operation || ""));
}

export function quoteSendDeliveryState(
  input: HudApprovalLifecycleInput,
): "not-applicable" | "awaiting_commissioning" | "commissioned" {
  if (!isQuoteSend(input.action)) return "not-applicable";
  if (input.quoteDeliveryCommissioned === true) return "commissioned";
  return "awaiting_commissioning";
}

function isExpired(action: HudApprovalActionView, now: number): boolean {
  if (action.state === "expired" || action.isApprovalExpired === true) return true;
  if (!action.approvalExpiresAt) return false;
  const expiresAt = Date.parse(action.approvalExpiresAt);
  return Number.isFinite(expiresAt) && now >= expiresAt;
}

export function executionModeOf(receipt: HudReceiptObservation): ToolExecutionMode {
  if (receipt.executionMode) return receipt.executionMode;
  if (receipt.status === "dry-run") return "dry-run";
  return "live";
}

export function selectLiveReceiptObservation(
  input: HudApprovalLifecycleInput,
): HudReceiptObservation | null {
  const observed = [...(input.receipts ?? []), ...(input.receipt ? [input.receipt] : [])];
  const live = observed.filter((receipt) => executionModeOf(receipt) === "live");
  return live[0] ?? null;
}

function fromLiveReceipt(status: ToolExecutionStatus): HudApprovalStage {
  if (status === "blocked") return "execution_blocked";
  if (status === "failed") return "execution_failed";
  if (status === "indeterminate") return "outcome_unknown";
  if (status === "succeeded") return "receipt_received";
  if (status === "dry-run") return "awaiting_execution";
  return "outcome_unknown";
}

function fromReconciliation(observation: HudReconciliationObservation): HudApprovalStage | null {
  if (!observation) return null;
  if (observation.terminalStatus === "failed") {
    return "execution_failed";
  }
  if (observation.state === "resolved" && observation.terminalStatus === "succeeded") {
    return "reconciled";
  }
  if (
    observation.state === "pending" ||
    observation.state === "observing" ||
    observation.state === "claimed"
  ) {
    return "reconciliation_pending";
  }
  return "outcome_unknown";
}

/**
 * Maps authoritative proposal / inspection / receipt / reconciliation facts
 * onto HUD presentation. Never maps missing observation to FAILURE.
 * Never treats a dry-run receipt as live execution.
 */
export function deriveHudApprovalStage(input: HudApprovalLifecycleInput): HudApprovalStage {
  const action = input.action;
  if (!action) return "awaiting_inspection";
  const now = input.now ?? Date.now();

  if (action.state === "rejected") return "rejected";
  if (action.state === "revoked") return "stale";
  if (isExpired(action, now)) return "expired";

  if (action.state === "proposed") {
    if (input.inspection.required) {
      if (input.inspection.state === "error" || input.inspection.state === "not-found") {
        return "inspection_failed";
      }
      if (input.inspection.state === "ready") {
        if (quoteSendDeliveryState(input) === "awaiting_commissioning") {
          return "awaiting_commissioning";
        }
        return "awaiting_approval";
      }
      return "awaiting_inspection";
    }
    return "awaiting_approval";
  }

  if (action.state !== "approved") return "stale";

  if (input.executionInFlight === true) return "executing";

  const reconStage = fromReconciliation(input.reconciliation ?? null);
  if (reconStage) return reconStage;

  const live = selectLiveReceiptObservation(input);
  if (live) return fromLiveReceipt(live.status);

  if (input.receiptAvailable === true) return "awaiting_execution";

  return "outcome_unknown";
}

export function canSubmitApproval(input: HudApprovalLifecycleInput): boolean {
  return deriveHudApprovalStage(input) === "awaiting_approval";
}

export function isDuplicateApprovalAttempt(action: { state: ToolActionState } | null): boolean {
  return action?.state === "approved";
}

export function approvalStageLabel(stage: HudApprovalStage): string {
  return HUD_APPROVAL_STAGE_LABELS[stage];
}
