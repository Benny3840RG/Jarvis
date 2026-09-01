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
const effectPayload = { reviewedHeadSha: "abc123" };
const mergeDefinition = DEVELOPMENT_TRANSITIONS.DEV_TRANSITION_READY_TO_MERGE_TO_MERGED;

function validApproval(overrides: Partial<ApprovalRef> = {}): ApprovalRef {
  return {
    approvalId: "approval-1",
    actorType: "operator",
    actorId: "benny",
    maxRiskClass: 2,
    subjectId,
    transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
    proposalHash: "proposal-hash-opaque",
    approvedSha: "abc123",
    effectHash: computeEffectHash({
      transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
      subjectId,
      from: "READY_TO_MERGE",
      to: "MERGED",
      effectPayload,
    }),
    authorityEnvelopeHash: computeAuthorityEnvelopeHash(missionAuthority),
    effectiveRisk: 2,
    policyDecisionFingerprint: computePolicyDecisionFingerprint(mergeDefinition),
    ...overrides,
  };
}

function mergeRequest(overrides: Partial<TransitionRequest> = {}): TransitionRequest {
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
    effectPayload,
    riskClass: 2,
    approval: validApproval(),
    ...overrides,
  };
}

test("a fully-matching approval (subject, transition, effect, authority envelope, policy fingerprint) is admitted", () => {
  const result = evaluateDevelopmentTransition(mergeRequest());
  assert.equal(result.allowed, true);
});

test("a caller cannot bypass approval on an S4 transition by asserting a low risk class", () => {
  // handover "Risk": model/caller may raise risk, never lower the
  // deterministic floor. READY_TO_MERGE_TO_MERGED is S4 -> floor 2,
  // regardless of what riskClass claims.
  const result = evaluateDevelopmentTransition(mergeRequest({ riskClass: 0, approval: undefined }));

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("OPERATOR_APPROVAL_REQUIRED"));
});

test("evidence-derived or model-suggested risk can raise the effective risk above the floor", () => {
  const result = evaluateDevelopmentTransition(
    mergeRequest({
      riskClass: 0,
      evidenceDerivedRisk: 3,
      approval: validApproval({ maxRiskClass: 2 }),
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("OPERATOR_APPROVAL_REQUIRED"));
});

test("an approval bound to a different transition ID is rejected", () => {
  const result = evaluateDevelopmentTransition(
    mergeRequest({
      approval: validApproval({ transitionId: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE" }),
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("APPROVAL_TRANSITION_MISMATCH"));
});

test("an approval bound to a different subject is rejected", () => {
  const result = evaluateDevelopmentTransition(
    mergeRequest({ approval: validApproval({ subjectId: "mission-2" }) }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("APPROVAL_SUBJECT_MISMATCH"));
});

test("an approval whose effect hash no longer matches the live proposal (e.g. a moved SHA) is rejected", () => {
  const result = evaluateDevelopmentTransition(
    mergeRequest({ effectPayload: { reviewedHeadSha: "different-sha" } }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("APPROVAL_EFFECT_MISMATCH"));
});

test("an approval scoped to a different authority envelope is rejected", () => {
  const narrowerAuthority: CapabilityEnvelope = {
    ...missionAuthority,
    branches: ["some-other-branch"],
  };
  const result = evaluateDevelopmentTransition(
    mergeRequest({
      approval: validApproval({
        authorityEnvelopeHash: computeAuthorityEnvelopeHash(narrowerAuthority),
      }),
    }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("APPROVAL_AUTHORITY_ENVELOPE_MISMATCH"));
});

test("an approval carrying a stale policy-decision fingerprint is rejected, distinctly, even though risk/effect/authority all still match", () => {
  const result = evaluateDevelopmentTransition(
    mergeRequest({ approval: validApproval({ policyDecisionFingerprint: "stale-fingerprint" }) }),
  );

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("APPROVAL_STALE_POLICY_CONTEXT"));
});

test("computePolicyDecisionFingerprint is stable for the same transition definition and does not depend on unrelated registry entries", () => {
  const a = computePolicyDecisionFingerprint(mergeDefinition);
  const b = computePolicyDecisionFingerprint(mergeDefinition);
  assert.equal(a, b);

  const otherDefinition = DEVELOPMENT_TRANSITIONS.DEV_TRANSITION_CLAIMED_TO_BUILDING;
  assert.notEqual(a, computePolicyDecisionFingerprint(otherDefinition));
});
