import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVELOPMENT_TRANSITIONS,
  evaluateDevelopmentTransition,
  type CapabilityEnvelope,
  type TransitionRequest,
} from "../src/development/stateMachine.js";

const missionAuthority: CapabilityEnvelope = {
  repositories: ["Benny3840RG/Jarvis"],
  branches: ["agent/governed-dev-state-machine-phase1"],
  externalEffects: ["github.merge"],
  maxRiskClass: 3,
};

function baseRequest(overrides: Partial<TransitionRequest> = {}): TransitionRequest {
  return {
    transitionId: "DEV_TRANSITION_CLAIMED_TO_BUILDING",
    from: "CLAIMED",
    to: "BUILDING",
    now: "2026-09-01T00:00:00.000Z",
    requestedBy: { actorType: "worker", actorId: "worker-1" },
    evaluatedBy: { actorType: "controller", actorId: "development-gate" },
    authorisedBy: { actorType: "control-plane", actorId: "development-policy" },
    committedBy: { actorType: "controller", actorId: "development-controller" },
    workerId: "worker-1",
    lease: {
      leaseId: "lease-1",
      workerId: "worker-1",
      expiresAt: "2026-09-01T01:00:00.000Z",
    },
    missionAuthority,
    workerAuthority: missionAuthority,
    branch: "agent/governed-dev-state-machine-phase1",
    repository: "Benny3840RG/Jarvis",
    ...overrides,
  };
}

test("transition registry exposes stable claimed-to-building contract", () => {
  const transition = DEVELOPMENT_TRANSITIONS.DEV_TRANSITION_CLAIMED_TO_BUILDING;

  assert.equal(transition.id, "DEV_TRANSITION_CLAIMED_TO_BUILDING");
  assert.equal(transition.from, "CLAIMED");
  assert.equal(transition.to, "BUILDING");
  assert.equal(transition.sideEffectClass, "S2");
  assert.equal(transition.authoritativeCommitter, "controller");
});

test("legal claimed-to-building request is admitted", () => {
  const result = evaluateDevelopmentTransition(baseRequest());

  assert.equal(result.allowed, true);
  assert.equal(result.outcome, "ALLOWED");
  assert.deepEqual(result.reasons, []);
});

test("unknown or mismatched transition is rejected without changing state", () => {
  const result = evaluateDevelopmentTransition(
    baseRequest({
      transitionId: "DEV_TRANSITION_CLAIMED_TO_BUILDING",
      from: "READY",
    }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.outcome, "REJECTED");
  assert.ok(result.reasons.includes("STATE_MISMATCH"));
});

test("expired lease rejects worker transition", () => {
  const result = evaluateDevelopmentTransition(
    baseRequest({
      now: "2026-09-01T02:00:00.000Z",
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("LEASE_EXPIRED"));
});

test("worker authority cannot exceed mission authority", () => {
  const result = evaluateDevelopmentTransition(
    baseRequest({
      workerAuthority: {
        ...missionAuthority,
        branches: ["main"],
      },
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("AUTHORITY_EXPANSION"));
});

test("risk class 2 merge requires explicit operator approval", () => {
  const result = evaluateDevelopmentTransition(
    baseRequest({
      transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
      from: "READY_TO_MERGE",
      to: "MERGED",
      requestedBy: { actorType: "controller", actorId: "merge-executor" },
      committedBy: { actorType: "controller", actorId: "development-controller" },
      riskClass: 2,
      mergeEvidence: {
        reviewedHeadSha: "abc123",
        currentHeadSha: "abc123",
        reconciledMergedCommitSha: "def456",
      },
      approval: undefined,
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("OPERATOR_APPROVAL_REQUIRED"));
});

test("risk class 2 merge is admitted with matching explicit operator approval", () => {
  const result = evaluateDevelopmentTransition(
    baseRequest({
      transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
      from: "READY_TO_MERGE",
      to: "MERGED",
      requestedBy: { actorType: "controller", actorId: "merge-executor" },
      committedBy: { actorType: "controller", actorId: "development-controller" },
      riskClass: 2,
      mergeEvidence: {
        reviewedHeadSha: "abc123",
        currentHeadSha: "abc123",
        reconciledMergedCommitSha: "def456",
      },
      approval: {
        approvalId: "approval-1",
        actorType: "operator",
        actorId: "benny",
        maxRiskClass: 2,
      },
    }),
  );

  assert.equal(result.allowed, true);
});

test("completion transition rejects any non-Omega committer", () => {
  const result = evaluateDevelopmentTransition(
    baseRequest({
      transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
      from: "MERGED",
      to: "COMPLETE",
      requestedBy: { actorType: "controller", actorId: "mission-engine" },
      evaluatedBy: { actorType: "omega", actorId: "omega-sigma" },
      authorisedBy: { actorType: "omega", actorId: "omega-sigma" },
      committedBy: { actorType: "controller", actorId: "development-controller" },
      completionEvidence: {
        evaluationId: "omega-eval-1",
        decision: "COMPLETE",
        blockingContradictions: 0,
        reconciliationOpen: false,
      },
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("OMEGA_COMMITTER_REQUIRED"));
});

test("Omega completion requires a complete evaluation with no blocking reconciliation or contradiction", () => {
  const result = evaluateDevelopmentTransition(
    baseRequest({
      transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
      from: "MERGED",
      to: "COMPLETE",
      requestedBy: { actorType: "controller", actorId: "mission-engine" },
      evaluatedBy: { actorType: "omega", actorId: "omega-sigma" },
      authorisedBy: { actorType: "omega", actorId: "omega-sigma" },
      committedBy: { actorType: "omega", actorId: "omega-sigma" },
      completionEvidence: {
        evaluationId: "omega-eval-2",
        decision: "COMPLETE",
        blockingContradictions: 1,
        reconciliationOpen: false,
      },
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("OMEGA_EVIDENCE_NOT_COMPLETE"));
});
