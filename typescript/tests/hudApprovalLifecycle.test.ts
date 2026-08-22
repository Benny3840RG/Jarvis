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
  quoteSendDeliveryState,
  selectLiveReceiptObservation,
} from "../src/hud/hudApprovalLifecycle.js";

const NOW = Date.parse("2026-08-23T00:00:00.000Z");

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
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    approvalExpiryPolicy: "ttl",
    approvalExpiresAt: "2026-08-23T01:00:00.000Z",
    ...overrides,
  };
}

function approvedInput(
  extra: Partial<Parameters<typeof deriveHudApprovalStage>[0]> = {},
): Parameters<typeof deriveHudApprovalStage>[0] {
  return {
    action: proposed({ state: "approved" }),
    inspection: { required: true, state: "ready" },
    now: NOW,
    ...extra,
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
      action: proposed({ operation: "notes:create", tool: "createNoteTool", arguments: {} }),
      inspection: { required: false, state: "not-required" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(input), "awaiting_approval");
    assert.equal(canSubmitApproval(input), true);
  });

  it("does not imply quotes:send is live while delivery is uncommissioned", () => {
    const input = {
      action: proposed(),
      inspection: { required: true, state: "ready" as const },
      quoteDeliveryCommissioned: false,
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(input), "awaiting_commissioning");
    assert.equal(quoteSendDeliveryState(input), "awaiting_commissioning");
  });

  it("maps approved + receipt observation unavailable to outcome unknown, never failure", () => {
    const input = approvedInput({ receiptAvailable: false });
    assert.equal(deriveHudApprovalStage(input), "outcome_unknown");
    assert.notEqual(deriveHudApprovalStage(input), "execution_failed");
  });

  it("maps approved + successful receipt read + no live receipt to awaiting_execution", () => {
    const input = approvedInput({ receiptAvailable: true, receipts: [] });
    assert.equal(deriveHudApprovalStage(input), "awaiting_execution");
    assert.notEqual(deriveHudApprovalStage(input), "executing");
  });

  it("does not treat a dry-run success as live execution", () => {
    const input = approvedInput({
      receiptAvailable: true,
      receipts: [{ status: "succeeded", executionMode: "dry-run" }],
    });
    assert.equal(deriveHudApprovalStage(input), "awaiting_execution");
    assert.equal(selectLiveReceiptObservation(input), null);
    assert.notEqual(deriveHudApprovalStage(input), "receipt_received");
  });

  it("uses the live success receipt when dry-run and live coexist", () => {
    const input = approvedInput({
      receiptAvailable: true,
      receipts: [
        { status: "succeeded", executionMode: "dry-run" },
        { status: "succeeded", executionMode: "live" },
      ],
    });
    assert.equal(deriveHudApprovalStage(input), "receipt_received");
    assert.deepEqual(selectLiveReceiptObservation(input), {
      status: "succeeded",
      executionMode: "live",
    });
  });

  it("maps live failed, blocked, and indeterminate receipts distinctly", () => {
    assert.equal(
      deriveHudApprovalStage(
        approvedInput({
          receiptAvailable: true,
          receipts: [{ status: "failed", executionMode: "live" }],
        }),
      ),
      "execution_failed",
    );
    assert.equal(
      deriveHudApprovalStage(
        approvedInput({
          receiptAvailable: true,
          receipts: [{ status: "blocked", executionMode: "live" }],
        }),
      ),
      "execution_blocked",
    );
    assert.equal(
      deriveHudApprovalStage(
        approvedInput({
          receiptAvailable: true,
          receipts: [{ status: "indeterminate", executionMode: "live" }],
        }),
      ),
      "outcome_unknown",
    );
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
        approvalExpiresAt: "2026-08-22T23:00:00.000Z",
      }),
      inspection: { required: true, state: "ready" as const },
      now: NOW,
    };
    assert.equal(deriveHudApprovalStage(expired), "expired");
    assert.equal(canSubmitApproval(expired), false);

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
      canSubmitApproval(approvedInput({ receiptAvailable: true, receipts: [] })),
      false,
    );
  });

  it("keeps reconciliation pending distinct from reconciled and failed", () => {
    assert.equal(
      deriveHudApprovalStage(
        approvedInput({ reconciliation: { state: "pending" } }),
      ),
      "reconciliation_pending",
    );
    assert.equal(
      deriveHudApprovalStage(
        approvedInput({
          reconciliation: { state: "resolved", terminalStatus: "succeeded" },
        }),
      ),
      "reconciled",
    );
    assert.equal(
      deriveHudApprovalStage(
        approvedInput({
          reconciliation: { state: "resolved", terminalStatus: "failed" },
        }),
      ),
      "execution_failed",
    );
  });

  it("only reports executing when runtime says an execution is in flight", () => {
    assert.equal(deriveHudApprovalStage(approvedInput({ receiptAvailable: false })), "outcome_unknown");
    assert.equal(
      deriveHudApprovalStage(approvedInput({ executionInFlight: true })),
      "executing",
    );
  });

  it("documents complete-task confirmation as an accidental-click safeguard only", () => {
    assert.equal(COMPLETE_TASK_SEMANTICS.mutatesDurableTask, true);
    assert.equal(COMPLETE_TASK_SEMANTICS.requiresConfirmation, true);
    assert.equal(COMPLETE_TASK_SEMANTICS.confirmationIsAuthorisationBoundary, false);
    assert.equal(COMPLETE_TASK_SEMANTICS.approvesQuote, false);
    assert.equal(COMPLETE_TASK_SEMANTICS.sendsQuote, false);
    assert.equal(COMPLETE_TASK_SEMANTICS.executesToolAction, false);
    assert.match(COMPLETE_TASK_SEMANTICS.confirmationCopy, /does not constitute an authorisation boundary/i);
    assert.match(COMPLETE_TASK_SEMANTICS.confirmationCopy, /does not approve or send a quote/i);
  });

  it("keeps approval execution on the HTTP operator path with a separate token", () => {
    assert.equal(HUD_APPROVAL_OPERATOR_PATH.widgetMayStoreApprovalToken, false);
    assert.equal(HUD_APPROVAL_OPERATOR_PATH.widgetMayCallApprove, false);
    assert.equal(HUD_APPROVAL_OPERATOR_PATH.widgetMayCallExecute, false);
    assert.match(HUD_APPROVAL_OPERATOR_PATH.inspectReceipts, /\/receipts$/);
    assert.equal(HUD_APPROVAL_OPERATOR_PATH.approvalCredential, "JARVIS_APPROVAL_TOKEN");
  });
});
