import assert from "node:assert/strict";
import test from "node:test";

import {
  computeAuthorityEnvelopeHash,
  computeEffectHash,
  computePolicyDecisionFingerprint,
  evaluateAllScopeInvalidation,
  evaluateDevelopmentTransition,
  isRetroactivelyInvalidated,
  markApprovalTransitionCommitted,
  DEVELOPMENT_TRANSITIONS,
  type ApprovalRef,
  type CapabilityEnvelope,
  type PolicyHistoryEntry,
  type TransitionRequest,
} from "../src/development/stateMachine.js";

const missionAuthority: CapabilityEnvelope = {
  repositories: ["Benny3840RG/Jarvis"],
  branches: ["agent/governed-dev-state-machine-phase1"],
  externalEffects: ["github.merge"],
  maxRiskClass: 3,
};

const subjectId = "mission-1";
const effectPayload = { reviewedHeadSha: "abc123" };
const mergeDefinition = DEVELOPMENT_TRANSITIONS.DEV_TRANSITION_READY_TO_MERGE_TO_MERGED;
const transitionId = "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED";

function approval(overrides: Partial<ApprovalRef> = {}): ApprovalRef {
  return {
    approvalId: "approval-1",
    actorType: "operator",
    actorId: "benny",
    maxRiskClass: 2,
    subjectId,
    transitionId,
    proposalHash: "proposal-hash-opaque",
    approvedSha: "abc123",
    effectHash: computeEffectHash({
      transitionId,
      subjectId,
      from: "READY_TO_MERGE",
      to: "MERGED",
      effectPayload,
    }),
    authorityEnvelopeHash: computeAuthorityEnvelopeHash(missionAuthority),
    effectiveRisk: 2,
    policyDecisionFingerprint: computePolicyDecisionFingerprint(mergeDefinition),
    policySubjectVersion: 1,
    transitionCommitted: false,
    ...overrides,
  };
}

function historyEntry(
  subjectVersion: number,
  overrides: Partial<PolicyHistoryEntry> = {},
): PolicyHistoryEntry {
  return {
    subjectVersion,
    version: `v${subjectVersion}`,
    validFrom: "2026-09-23T00:00:00.000Z",
    retroactiveInvalidation: {
      transitionIds: [transitionId],
      affectedApprovals: "ALL",
      scope: "PENDING_ONLY",
      reason: "policy correction",
    },
    ...overrides,
  };
}

function mergeRequest(overrides: Partial<TransitionRequest> = {}): TransitionRequest {
  return {
    transitionId,
    from: "READY_TO_MERGE",
    to: "MERGED",
    now: "2026-09-23T00:00:00.000Z",
    requestedBy: { actorType: "controller", actorId: "merge-executor" },
    committedBy: { actorType: "controller", actorId: "development-controller" },
    subjectId,
    missionAuthority,
    workerAuthority: missionAuthority,
    effectPayload,
    riskClass: 2,
    approval: approval(),
    ...overrides,
  };
}

test("policy history orders by subjectVersion and has no sequenceNumber field", () => {
  const entry = historyEntry(2);
  assert.equal(entry.subjectVersion, 2);
  assert.equal("sequenceNumber" in entry, false);
  assert.equal(
    isRetroactivelyInvalidated(approval({ policySubjectVersion: 1 }), transitionId, [entry], 2),
    true,
  );
});

test("PENDING_ONLY invalidates uncommitted approvals and leaves committed ones", () => {
  const history = [historyEntry(2)];
  assert.equal(
    isRetroactivelyInvalidated(
      approval({ policySubjectVersion: 1, transitionCommitted: false }),
      transitionId,
      history,
      2,
    ),
    true,
  );
  assert.equal(
    isRetroactivelyInvalidated(
      approval({ policySubjectVersion: 1, transitionCommitted: true }),
      transitionId,
      history,
      2,
    ),
    false,
  );
});

test("omitted invalidation scope defaults to PENDING_ONLY", () => {
  const history = [
    historyEntry(2, {
      retroactiveInvalidation: {
        transitionIds: [transitionId],
        affectedApprovals: "ALL",
        reason: "policy correction",
      },
    }),
  ];
  assert.equal(
    isRetroactivelyInvalidated(approval({ transitionCommitted: true }), transitionId, history, 2),
    false,
  );
  assert.equal(
    isRetroactivelyInvalidated(approval({ transitionCommitted: false }), transitionId, history, 2),
    true,
  );
});

test("scope ALL invalidates a committed approval for the named transition", () => {
  const history = [
    historyEntry(3, {
      retroactiveInvalidation: {
        transitionIds: [transitionId],
        affectedApprovals: "ALL",
        scope: "ALL",
        reason: "withdraw the executed approval class",
      },
    }),
  ];
  assert.equal(
    isRetroactivelyInvalidated(
      approval({ policySubjectVersion: 1, transitionCommitted: true }),
      transitionId,
      history,
      3,
    ),
    true,
  );
});

test("specific approval ids and other transitions are not swept up", () => {
  const history = [
    historyEntry(2, {
      retroactiveInvalidation: {
        transitionIds: ["DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE"],
        affectedApprovals: { approvalIds: ["approval-1"] },
        scope: "PENDING_ONLY",
        reason: "different transition",
      },
    }),
    historyEntry(3, {
      retroactiveInvalidation: {
        transitionIds: [transitionId],
        affectedApprovals: { approvalIds: ["approval-other"] },
        scope: "ALL",
        reason: "different approval",
      },
    }),
  ];
  assert.equal(isRetroactivelyInvalidated(approval(), transitionId, history, 3), false);
});

test("versions outside the approval snapshot and current policy version are ignored", () => {
  const history = [historyEntry(1), historyEntry(4)];
  assert.equal(
    isRetroactivelyInvalidated(approval({ policySubjectVersion: 2 }), transitionId, history, 3),
    false,
  );
});

test("markApprovalTransitionCommitted records consumption without a mission COMPLETE state", () => {
  const consumed = markApprovalTransitionCommitted(approval());
  assert.equal(consumed.transitionCommitted, true);
  assert.equal(consumed.policySubjectVersion, 1);
  assert.equal("state" in consumed, false);
  assert.equal(markApprovalTransitionCommitted(consumed), consumed);
});

test("a consumed approval cannot authorise another transition", () => {
  const result = evaluateDevelopmentTransition(
    mergeRequest({ approval: approval({ transitionCommitted: true }) }),
  );
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("APPROVAL_TRANSITION_ALREADY_COMMITTED"));
  assert.equal(result.reasons.includes("COMPLETE"), false);
});

test("pending-only policy history rejects an uncommitted approval and admits a committed one only as already consumed", () => {
  const policyHistory = [historyEntry(2)];
  const pending = evaluateDevelopmentTransition(
    mergeRequest({ policyHistory, currentPolicySubjectVersion: 2 }),
  );
  assert.equal(pending.allowed, false);
  assert.ok(pending.reasons.includes("APPROVAL_RETROACTIVELY_INVALIDATED"));

  const committed = evaluateDevelopmentTransition(
    mergeRequest({
      policyHistory,
      currentPolicySubjectVersion: 2,
      approval: approval({ transitionCommitted: true }),
    }),
  );
  assert.equal(committed.allowed, false);
  assert.ok(committed.reasons.includes("APPROVAL_TRANSITION_ALREADY_COMMITTED"));
  assert.equal(committed.reasons.includes("APPROVAL_RETROACTIVELY_INVALIDATED"), false);
});

test("a partial policy-history argument fails closed", () => {
  const result = evaluateDevelopmentTransition(mergeRequest({ policyHistory: [historyEntry(2)] }));
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("POLICY_HISTORY_INCOMPLETE"));
});

test("affectedApprovals ALL requires risk class 3 and an audit trail in phase 1", () => {
  const invalidation = {
    transitionIds: [transitionId],
    affectedApprovals: "ALL" as const,
    scope: "PENDING_ONLY" as const,
    reason: "policy correction",
  };
  assert.deepEqual(
    evaluateAllScopeInvalidation({
      invalidation,
      authorityRiskClass: 2,
      auditTrailRecorded: true,
    }).reasons,
    ["ALL_SCOPE_RISK_3_REQUIRED"],
  );
  assert.deepEqual(
    evaluateAllScopeInvalidation({
      invalidation,
      authorityRiskClass: 3,
      auditTrailRecorded: false,
    }).reasons,
    ["ALL_SCOPE_AUDIT_TRAIL_REQUIRED"],
  );
  assert.equal(
    evaluateAllScopeInvalidation({
      invalidation,
      authorityRiskClass: 3,
      auditTrailRecorded: true,
    }).admissible,
    true,
  );
  assert.equal(
    evaluateAllScopeInvalidation({
      invalidation: {
        transitionIds: [transitionId],
        affectedApprovals: { approvalIds: ["approval-1"] },
        reason: "one approval",
      },
      authorityRiskClass: 0,
      auditTrailRecorded: false,
    }).admissible,
    true,
  );
});
