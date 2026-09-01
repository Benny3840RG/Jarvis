import assert from "node:assert/strict";
import test from "node:test";

import {
  computeAuthorityEnvelopeHash,
  computeEffectHash,
  computePolicyDecisionFingerprint,
  evaluateDevelopmentTransition,
  DEVELOPMENT_TRANSITIONS,
  type ApprovalRef,
  type CapabilityEnvelope,
  type TransitionRequest,
} from "../src/development/stateMachine.js";

const missionAuthority: CapabilityEnvelope = {
  repositories: ["Benny3840RG/Jarvis"],
  branches: ["agent/governed-dev-state-machine-phase1"],
  externalEffects: ["github.merge"],
  maxRiskClass: 3,
};

const subjectId = "mission-1";
const originalEffectPayload = { reviewedHeadSha: "abc123" };
const mergeDefinition = DEVELOPMENT_TRANSITIONS.DEV_TRANSITION_READY_TO_MERGE_TO_MERGED;

function approval(overrides: Partial<ApprovalRef> = {}): ApprovalRef {
  return {
    approvalId: "approval-1",
    actorType: "operator",
    actorId: "benny",
    maxRiskClass: 2,
    subjectId,
    transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
    proposalHash: "proposal-hash-opaque",
    effectHash: computeEffectHash({
      transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
      subjectId,
      from: "READY_TO_MERGE",
      to: "MERGED",
      effectPayload: originalEffectPayload,
    }),
    approvedSha: "abc123",
    authorityEnvelopeHash: computeAuthorityEnvelopeHash(missionAuthority),
    effectiveRisk: 2,
    policyDecisionFingerprint: computePolicyDecisionFingerprint(mergeDefinition),
    ...overrides,
  };
}

function failedMergeRequest(overrides: Partial<TransitionRequest> = {}): TransitionRequest {
  return {
    transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
    from: "READY_TO_MERGE",
    to: "MERGED",
    now: "2026-09-01T00:00:00.000Z",
    requestedBy: { actorType: "controller", actorId: "merge-executor" },
    committedBy: { actorType: "controller", actorId: "development-controller" },
    subjectId,
    missionAuthority,
    workerAuthority: missionAuthority,
    effectPayload: originalEffectPayload,
    riskClass: 2,
    approval: approval(),
    mergeEvidence: {
      reviewedHeadSha: "abc123",
      currentHeadSha: "abc123",
      operationOutcome: "FAILED",
    },
    ...overrides,
  };
}

test("a failed merge with an unchanged effect can resume the same operation", () => {
  const result = evaluateDevelopmentTransition(failedMergeRequest());

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("MERGE_OPERATION_FAILED"));
  assert.equal(result.retryDisposition, "RESUME_SAME_OPERATION");
});

test("a failed merge whose reviewed head moved since approval requires a new execution, not a resume", () => {
  // effectPayload is left matching the approval's effectHash (so this stays
  // an APPROVAL_EFFECT_MISMATCH-free, purely merge-outcome case) while the
  // proposed head itself has moved past what was actually approved.
  const result = evaluateDevelopmentTransition(
    failedMergeRequest({
      mergeEvidence: {
        reviewedHeadSha: "a-different-sha-pushed-meanwhile",
        currentHeadSha: "a-different-sha-pushed-meanwhile",
        operationOutcome: "FAILED",
      },
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("MERGE_OPERATION_FAILED"));
  assert.equal(result.retryDisposition, "NEW_EXECUTION_REQUIRED");
});

test("a failed merge explicitly marked non-retryable derives NO_RETRY", () => {
  const result = evaluateDevelopmentTransition(
    failedMergeRequest({
      mergeEvidence: {
        reviewedHeadSha: "abc123",
        currentHeadSha: "abc123",
        operationOutcome: "FAILED",
        retryable: false,
      },
    }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.retryDisposition, "NO_RETRY");
});

test("retry disposition is derived only for FAILED outcomes -- not all failures are automatically retriable", () => {
  const rejectedOutcome = evaluateDevelopmentTransition(
    failedMergeRequest({
      mergeEvidence: {
        reviewedHeadSha: "abc123",
        currentHeadSha: "abc123",
        operationOutcome: "REJECTED",
      },
    }),
  );
  const indeterminateOutcome = evaluateDevelopmentTransition(
    failedMergeRequest({
      mergeEvidence: {
        reviewedHeadSha: "abc123",
        currentHeadSha: "abc123",
        operationOutcome: "INDETERMINATE",
      },
    }),
  );

  assert.equal(rejectedOutcome.retryDisposition, undefined);
  assert.equal(indeterminateOutcome.retryDisposition, undefined);
});

test("an allowed evaluation carries no retry disposition", () => {
  const result = evaluateDevelopmentTransition(
    failedMergeRequest({
      mergeEvidence: {
        reviewedHeadSha: "abc123",
        currentHeadSha: "abc123",
        operationOutcome: "MERGED",
        reconciledMergedCommitSha: "def456",
      },
    }),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.retryDisposition, undefined);
});
