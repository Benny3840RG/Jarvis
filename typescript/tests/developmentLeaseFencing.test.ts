import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateDevelopmentTransition,
  type CapabilityEnvelope,
} from "../src/development/stateMachine.js";

const missionAuthority: CapabilityEnvelope = {
  repositories: ["Benny3840RG/Jarvis"],
  branches: ["agent/governed-dev-state-machine-phase1"],
  externalEffects: ["github.merge"],
  maxRiskClass: 3,
};

function claimedToBuildingRequest(fencingToken: number, currentFencingToken?: number) {
  return {
    transitionId: "DEV_TRANSITION_CLAIMED_TO_BUILDING" as const,
    from: "CLAIMED" as const,
    to: "BUILDING" as const,
    now: "2026-09-01T00:00:00.000Z",
    requestedBy: { actorType: "worker" as const, actorId: "worker-1" },
    committedBy: { actorType: "controller" as const, actorId: "development-controller" },
    workerId: "worker-1",
    lease: {
      leaseToken: `lease-token-${fencingToken}`,
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-09-01T01:00:00.000Z",
      fencingToken,
    },
    missionAuthority,
    workerAuthority: missionAuthority,
    currentFencingToken,
  };
}

test("a lease matching the subject's current fencing token retains authority", () => {
  const result = evaluateDevelopmentTransition(claimedToBuildingRequest(2, 2));
  assert.equal(result.allowed, true);
});

test("a lease ahead of the subject's currently-known fencing token retains authority", () => {
  // The kernel doesn't itself issue tokens -- a caller presenting a token
  // newer than what the projection has seen is legitimate (e.g. the
  // projection hasn't observed the newest lease-issuance event yet).
  const result = evaluateDevelopmentTransition(claimedToBuildingRequest(3, 2));
  assert.equal(result.allowed, true);
});

test("an old worker's superseded fencing token loses authority even before expiry", () => {
  // JARVIS-017 / handover "Lease fencing": a strictly newer lease has
  // already been issued for this subject (fencingToken advanced to 2), so
  // worker A's still-unexpired token 1 must lose -- this is the case a
  // random-UUID lease token (the real orchestrationSteps shape today)
  // cannot express, since it has no ordering.
  const staleWorker = claimedToBuildingRequest(1, 2);
  const result = evaluateDevelopmentTransition(staleWorker);

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("STALE_FENCING_TOKEN"));
});

test("two workers racing a claim: only the higher fencing token wins, the loser is rejected distinctly from expiry", () => {
  const winner = claimedToBuildingRequest(2, 2);
  const loser = claimedToBuildingRequest(1, 2);

  const winnerResult = evaluateDevelopmentTransition(winner);
  const loserResult = evaluateDevelopmentTransition(loser);

  assert.equal(winnerResult.allowed, true);
  assert.equal(loserResult.allowed, false);
  assert.ok(loserResult.reasons.includes("STALE_FENCING_TOKEN"));
  assert.ok(!loserResult.reasons.includes("LEASE_EXPIRED"));
});
