import assert from "node:assert/strict";
import test from "node:test";

import type { OmegaCompletionInput } from "../src/omega/policy.js";
import {
  DEVELOPMENT_TRANSITIONS,
  computeAuthorityEnvelopeHash,
  computePolicyDecisionFingerprint,
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
      leaseToken: "lease-token-1",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-09-01T01:00:00.000Z",
      fencingToken: 1,
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
        subjectId: "mission-1",
        transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
        proposalHash: "proposal-hash-opaque",
        effectHash: "effect-hash-not-checked-without-effectPayload",
        authorityEnvelopeHash: computeAuthorityEnvelopeHash(missionAuthority),
        effectiveRisk: 2,
        policyDecisionFingerprint: computePolicyDecisionFingerprint(
          DEVELOPMENT_TRANSITIONS.DEV_TRANSITION_READY_TO_MERGE_TO_MERGED,
        ),
      },
    }),
  );

  assert.equal(result.allowed, true);
});

const passingOmegaCompletionInput: OmegaCompletionInput = {
  criteria: [{ criterionId: "crit-1" }],
  proofs: [
    { criterionId: "crit-1", result: "pass", independent: false, evidenceRefs: ["evidence-1"] },
  ],
  riskClass: "R0",
  unresolvedCriticalContradictions: 0,
  unreconciledExternalEffects: 0,
  residualUncertainty: 0,
  uncertaintyBudget: 0.1,
};

test("completion transition rejects any non-Omega committer, even with otherwise-passing completion input", () => {
  const result = evaluateDevelopmentTransition(
    baseRequest({
      transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
      from: "MERGED",
      to: "COMPLETE",
      requestedBy: { actorType: "controller", actorId: "mission-engine" },
      evaluatedBy: { actorType: "omega", actorId: "omega-sigma" },
      authorisedBy: { actorType: "omega", actorId: "omega-sigma" },
      committedBy: { actorType: "controller", actorId: "development-controller" },
      omegaCompletionInput: passingOmegaCompletionInput,
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("OMEGA_COMMITTER_REQUIRED"));
});

test("Omega completion delegates to the real evaluateOmegaCompletion policy and surfaces its exact failure codes", () => {
  // JARVIS-018: this kernel must not re-decide completion with its own
  // invented rule -- it reuses ../omega/policy.js's evaluateOmegaCompletion
  // verbatim and surfaces its real, multi-reason failure vocabulary rather
  // than collapsing it into a generic code.
  const result = evaluateDevelopmentTransition(
    baseRequest({
      transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
      from: "MERGED",
      to: "COMPLETE",
      requestedBy: { actorType: "controller", actorId: "mission-engine" },
      evaluatedBy: { actorType: "omega", actorId: "omega-sigma" },
      authorisedBy: { actorType: "omega", actorId: "omega-sigma" },
      committedBy: { actorType: "omega", actorId: "omega-sigma" },
      omegaCompletionInput: {
        ...passingOmegaCompletionInput,
        unresolvedCriticalContradictions: 1,
      },
    }),
  );

  assert.equal(result.allowed, false);
  // Exact code from evaluateOmegaCompletion, not a kernel-invented one.
  assert.ok(result.reasons.includes("critical-evidence-contradiction"));
});

test("a self-reported Omega committer with real passing completion input is admitted at the kernel level", () => {
  // This proves delegation to the real policy succeeds end to end -- it
  // does NOT prove authentication. Actual Omega identity is enforced by
  // the trusted commit boundary (convex/omegaMissions.ts#transition, gated
  // by requireOwner), which this pure kernel neither performs nor fakes.
  const result = evaluateDevelopmentTransition(
    baseRequest({
      transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
      from: "MERGED",
      to: "COMPLETE",
      requestedBy: { actorType: "controller", actorId: "mission-engine" },
      evaluatedBy: { actorType: "omega", actorId: "omega-sigma" },
      authorisedBy: { actorType: "omega", actorId: "omega-sigma" },
      committedBy: { actorType: "omega", actorId: "omega-sigma" },
      omegaCompletionInput: passingOmegaCompletionInput,
    }),
  );

  assert.equal(result.allowed, true);
});

test("a missing Omega completion input is rejected distinctly from a failing one", () => {
  const result = evaluateDevelopmentTransition(
    baseRequest({
      transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
      from: "MERGED",
      to: "COMPLETE",
      requestedBy: { actorType: "controller", actorId: "mission-engine" },
      evaluatedBy: { actorType: "omega", actorId: "omega-sigma" },
      authorisedBy: { actorType: "omega", actorId: "omega-sigma" },
      committedBy: { actorType: "omega", actorId: "omega-sigma" },
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("OMEGA_COMPLETION_INPUT_REQUIRED"));
});

test("a rejected transition describes a durable rejection without mutating the request", () => {
  const request = baseRequest({ from: "READY" });
  const frozen = deepFreeze(structuredClone(request));

  const result = evaluateDevelopmentTransition(frozen);

  assert.equal(result.allowed, false);
  assert.equal(result.outcome, "REJECTED");
  assert.ok(result.rejection);
  assert.equal(result.rejection?.transitionId, "DEV_TRANSITION_CLAIMED_TO_BUILDING");
  assert.equal(result.rejection?.sourceState, "READY");
  assert.deepEqual(result.rejection?.reasonCodes, result.reasons);
  assert.deepEqual(result.rejection?.requestedBy, request.requestedBy);
  // structuredClone + Object.freeze above already proves the evaluator
  // cannot have mutated `frozen` (a write would throw in strict mode); the
  // deep-equal below is a second, explicit proof against the pre-call clone.
  assert.deepEqual(frozen, structuredClone(request));
});

test("stale subject version loses a claim race to an already-advanced worker", () => {
  const winner = evaluateDevelopmentTransition(
    baseRequest({ expectedSubjectVersion: 1, currentSubjectVersion: 1 }),
  );
  assert.equal(winner.allowed, true);

  // Simulates a second worker whose request was formed against version 1
  // but is evaluated after the first worker's commit already advanced the
  // authoritative subject to version 2 — the classic same-version race.
  const loser = evaluateDevelopmentTransition(
    baseRequest({ expectedSubjectVersion: 1, currentSubjectVersion: 2 }),
  );
  assert.equal(loser.allowed, false);
  assert.ok(loser.reasons.includes("STALE_SUBJECT_VERSION"));
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
