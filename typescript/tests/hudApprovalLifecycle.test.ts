import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolAction } from "../src/actions/toolActions.js";
import {
  COMPLETE_TASK_SEMANTICS,
  HUD_APPROVAL_OPERATOR_PATH,
  canSubmitApproval,
  deriveHudApprovalStage,
  inspectionRequiredFor,
  isDuplicateApprovalAttempt,
} from "../src/hud/hudApprovalLifecycle.js";

const NOW = Date.parse("2026-08-22T00:00:00.000Z");

function proposed(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "act-1",
    requestId: "req-1",
    projectId: "project-1",
    baseRevision: 4,
    state: "proposed",
    tool: "quoteSendTool",
    operation: "quotes:send",
    arguments: { quoteId: "q1" },
    rationale: "Send finalised quote 174.",
    requiredAuthority: "T2",
    destructive: false,
    idempotencyKey: "preview-1",
    proposedBy: "agent",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    approvalExpiryPolicy: "ttl",
    approvalExpiresAt: "2026-08-22T01:00:00.000Z",
    ...overrides,
  };
}

describe("HUD approval lifecycle", () => {
  it("keeps approval unavailable when required quote inspection fails", () => {
    const input = {
      action: proposed(),
      inspection: { required: true, state: "error" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(input), "inspection_failed");
    assert.equal(canSubmitApproval(input), false);
    assert.equal(inspectionRequiredFor(proposed()), true);
  });

  it("enables the operator decision only after inspection succeeds on a live proposal", () => {
    const input = {
      action: proposed(),
      inspection: { required: true, state: "ready" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(input), "awaiting_approval");
    assert.equal(canSubmitApproval(input), true);
  });

  it("presents approval accepted without collapsing later stages into success", () => {
    const input = {
      action: proposed({ state: "approved" }),
      inspection: { required: true, state: "ready" as const },
      receiptAvailable: true,
      receipt: null,
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(input), "execution_pending");
    assert.equal(canSubmitApproval(input), false);
    assert.equal(
      deriveHudApprovalStage({
        ...input,
        receipt: { status: "dry-run" },
      }),
      "approval_accepted",
    );
  });

  it("never maps an unknown execution outcome to failure", () => {
    const missing = {
      action: proposed({ state: "approved" }),
      inspection: { required: true, state: "ready" as const },
      receiptAvailable: false,
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(missing), "outcome_unknown");

    const indeterminate = {
      ...missing,
      receiptAvailable: true,
      receipt: { status: "indeterminate" as const },
    };
    assert.equal(deriveHudApprovalStage(indeterminate), "outcome_unknown");
    assert.notEqual(deriveHudApprovalStage(missing), "execution_failed");
    assert.notEqual(deriveHudApprovalStage(indeterminate), "execution_failed");
  });

  it("presents rejected approval without executing", () => {
    const input = {
      action: proposed({ state: "rejected" }),
      inspection: { required: true, state: "ready" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(input), "rejected");
    assert.equal(canSubmitApproval(input), false);
  });

  it("treats expired and stale proposals as unapprovable", () => {
    const expired = {
      action: proposed({
        approvalExpiresAt: "2026-08-21T23:00:00.000Z",
      }),
      inspection: { required: true, state: "ready" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(expired), "expired");
    assert.equal(canSubmitApproval(expired), false);

    const marked = {
      action: proposed({ isApprovalExpired: true }),
      inspection: { required: true, state: "ready" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(marked), "expired");

    const revoked = {
      action: proposed({ state: "revoked" }),
      inspection: { required: true, state: "ready" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(revoked), "stale");
    assert.equal(canSubmitApproval(revoked), false);
  });

  it("refuses a duplicate approval attempt against an already-approved action", () => {
    const action = proposed({ state: "approved" });
    assert.equal(isDuplicateApprovalAttempt(action), true);
    assert.equal(
      canSubmitApproval({
        action,
        inspection: { required: true, state: "ready" },
        receiptAvailable: true,
        receipt: null,
        now: NOW,
      }),
      false,
    );
  });

  it("keeps reconciliation pending distinct from reconciled and failed", () => {
    const pending = {
      action: proposed({ state: "approved" }),
      inspection: { required: true, state: "ready" as const },
      reconciliation: { state: "pending" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(pending), "reconciliation_pending");

    const reconciled = {
      ...pending,
      reconciliation: { state: "resolved" as const, terminalStatus: "succeeded" as const },
    };
    assert.equal(deriveHudApprovalStage(reconciled), "reconciled");

    const failed = {
      action: proposed({ state: "approved" }),
      inspection: { required: true, state: "ready" as const },
      receiptAvailable: true,
      receipt: { status: "failed" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(failed), "execution_failed");
  });

  it("only reports executing when runtime says an execution is in flight", () => {
    const approved = {
      action: proposed({ state: "approved" }),
      inspection: { required: true, state: "ready" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(approved), "outcome_unknown");
    assert.equal(deriveHudApprovalStage({ ...approved, executionInFlight: true }), "executing");
  });

  it("documents complete-task as durable work, not quote approval", () => {
    assert.equal(COMPLETE_TASK_SEMANTICS.mutatesDurableTask, true);
    assert.equal(COMPLETE_TASK_SEMANTICS.requiresConfirmation, true);
    assert.equal(COMPLETE_TASK_SEMANTICS.approvesQuote, false);
    assert.equal(COMPLETE_TASK_SEMANTICS.sendsQuote, false);
    assert.equal(COMPLETE_TASK_SEMANTICS.executesToolAction, false);
    assert.equal(COMPLETE_TASK_SEMANTICS.hideBesideAwaitingApproval, true);
    assert.match(COMPLETE_TASK_SEMANTICS.confirmationCopy, /does not approve or send a quote/i);
  });

  it("keeps approval execution on the HTTP operator path with a separate token", () => {
    assert.equal(HUD_APPROVAL_OPERATOR_PATH.widgetMayStoreApprovalToken, false);
    assert.equal(HUD_APPROVAL_OPERATOR_PATH.widgetMayCallApprove, false);
    assert.equal(HUD_APPROVAL_OPERATOR_PATH.widgetMayCallExecute, false);
    assert.match(HUD_APPROVAL_OPERATOR_PATH.approve, /\/approve$/);
    assert.equal(HUD_APPROVAL_OPERATOR_PATH.approvalCredential, "JARVIS_APPROVAL_TOKEN");
  });
});
