import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVELOPMENT_TRANSITIONS,
  computeAuthorityEnvelopeHash,
  computePolicyDecisionFingerprint,
  evaluateDevelopmentTransition,
  type CapabilityEnvelope,
} from "../src/development/stateMachine.js";

const missionAuthority: CapabilityEnvelope = {
  repositories: ["Benny3840RG/Jarvis"],
  branches: ["agent/governed-dev-state-machine-phase1"],
  externalEffects: ["github.merge"],
  maxRiskClass: 3,
};

const approvedMergeRequestBase = {
  transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED" as const,
  from: "READY_TO_MERGE" as const,
  to: "MERGED" as const,
  now: "2026-09-01T00:00:00.000Z",
  requestedBy: { actorType: "controller" as const, actorId: "merge-executor" },
  committedBy: { actorType: "controller" as const, actorId: "development-controller" },
  missionAuthority,
  workerAuthority: missionAuthority,
  riskClass: 2,
  approval: {
    approvalId: "approval-1",
    actorType: "operator" as const,
    actorId: "benny",
    maxRiskClass: 2,
    subjectId: "mission-1",
    transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED" as const,
    proposalHash: "proposal-hash-opaque",
    effectHash: "effect-hash-not-checked-without-effectPayload",
    authorityEnvelopeHash: computeAuthorityEnvelopeHash(missionAuthority),
    effectiveRisk: 2,
    policyDecisionFingerprint: computePolicyDecisionFingerprint(
      DEVELOPMENT_TRANSITIONS.DEV_TRANSITION_READY_TO_MERGE_TO_MERGED,
    ),
  },
};

test("a proven-merged operation outcome is admitted", () => {
  const result = evaluateDevelopmentTransition({
    ...approvedMergeRequestBase,
    mergeEvidence: {
      reviewedHeadSha: "abc123",
      currentHeadSha: "abc123",
      reconciledMergedCommitSha: "def456",
      operationOutcome: "MERGED",
    },
  });

  assert.equal(result.allowed, true);
});

test("an indeterminate merge operation cannot transition directly to MERGED", () => {
  // JARVIS-005: ambiguity may not be coerced into success for convenience.
  const result = evaluateDevelopmentTransition({
    ...approvedMergeRequestBase,
    mergeEvidence: {
      reviewedHeadSha: "abc123",
      currentHeadSha: "abc123",
      operationOutcome: "INDETERMINATE",
    },
  });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("MERGE_OPERATION_INDETERMINATE"));
});

test("a failed merge operation is rejected with a distinct reason from indeterminate or plain rejection", () => {
  // JARVIS-015: REJECTED, FAILED, and INDETERMINATE are not interchangeable
  // -- each must be reason-coded distinctly, never collapsed into one label.
  const failed = evaluateDevelopmentTransition({
    ...approvedMergeRequestBase,
    mergeEvidence: {
      reviewedHeadSha: "abc123",
      currentHeadSha: "abc123",
      operationOutcome: "FAILED",
    },
  });
  const rejected = evaluateDevelopmentTransition({
    ...approvedMergeRequestBase,
    mergeEvidence: {
      reviewedHeadSha: "abc123",
      currentHeadSha: "abc123",
      operationOutcome: "REJECTED",
    },
  });
  const indeterminate = evaluateDevelopmentTransition({
    ...approvedMergeRequestBase,
    mergeEvidence: {
      reviewedHeadSha: "abc123",
      currentHeadSha: "abc123",
      operationOutcome: "INDETERMINATE",
    },
  });

  assert.equal(failed.allowed, false);
  assert.equal(rejected.allowed, false);
  assert.ok(failed.reasons.includes("MERGE_OPERATION_FAILED"));
  assert.ok(rejected.reasons.includes("MERGE_OPERATION_REJECTED"));
  const codes = new Set([...failed.reasons, ...rejected.reasons, ...indeterminate.reasons]);
  assert.equal(codes.size, 3, "each failure class must have its own distinct reason code");
});

test("reconciliation to MERGED requires authoritative external observation, not mere assertion", () => {
  const withoutObservation = evaluateDevelopmentTransition({
    transitionId: "DEV_TRANSITION_INDETERMINATE_TO_MERGED",
    from: "INDETERMINATE",
    to: "MERGED",
    now: "2026-09-01T00:00:00.000Z",
    requestedBy: { actorType: "reconciler", actorId: "reconciler-1" },
    committedBy: { actorType: "reconciler", actorId: "reconciler-1" },
  });

  assert.equal(withoutObservation.allowed, false);
  assert.ok(withoutObservation.reasons.includes("RECONCILIATION_EXTERNAL_OBSERVATION_REQUIRED"));

  const withObservation = evaluateDevelopmentTransition({
    transitionId: "DEV_TRANSITION_INDETERMINATE_TO_MERGED",
    from: "INDETERMINATE",
    to: "MERGED",
    now: "2026-09-01T00:00:00.000Z",
    requestedBy: { actorType: "reconciler", actorId: "reconciler-1" },
    committedBy: { actorType: "reconciler", actorId: "reconciler-1" },
    reconciliationEvidence: {
      externallyObserved: true,
      observedOutcome: "MERGED",
      observationSource: "github-merge-commit-lookup",
    },
  });

  assert.equal(withObservation.allowed, true);
});

test("elapsed time alone (a timeout) leaves reconciliation open rather than resolving it", () => {
  // JARVIS_EVENTS.md: "A timeout may trigger escalation or another
  // observation attempt, but must not automatically promote INDETERMINATE
  // to FAILED" -- and symmetrically must not promote it to MERGED either.
  const timeoutOnly = evaluateDevelopmentTransition({
    transitionId: "DEV_TRANSITION_INDETERMINATE_TO_MERGED",
    from: "INDETERMINATE",
    to: "MERGED",
    now: "2026-09-05T00:00:00.000Z",
    requestedBy: { actorType: "reconciler", actorId: "reconciler-1" },
    committedBy: { actorType: "reconciler", actorId: "reconciler-1" },
    reconciliationEvidence: {
      externallyObserved: false,
      observedOutcome: "STILL_UNKNOWN",
      observationSource: "timeout-elapsed-no-observation",
    },
  });

  assert.equal(timeoutOnly.allowed, false);
  assert.ok(timeoutOnly.reasons.includes("RECONCILIATION_EXTERNAL_OBSERVATION_REQUIRED"));

  const observedNotMerged = evaluateDevelopmentTransition({
    transitionId: "DEV_TRANSITION_INDETERMINATE_TO_MERGED",
    from: "INDETERMINATE",
    to: "MERGED",
    now: "2026-09-05T00:00:00.000Z",
    requestedBy: { actorType: "reconciler", actorId: "reconciler-1" },
    committedBy: { actorType: "reconciler", actorId: "reconciler-1" },
    reconciliationEvidence: {
      externallyObserved: true,
      observedOutcome: "NOT_MERGED",
      observationSource: "github-merge-commit-lookup",
    },
  });

  // A real, externally observed outcome of "not merged" is still not
  // "MERGED" -- resolving to MERGED requires the observation to actually
  // establish MERGED, not merely to exist.
  assert.equal(observedNotMerged.allowed, false);
  assert.ok(observedNotMerged.reasons.includes("RECONCILIATION_OUTCOME_NOT_PROVEN_MERGED"));
});
