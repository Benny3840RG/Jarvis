import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVELOPMENT_REDUCER_VERSION,
  InMemoryDevelopmentProjectionStore,
  applyDevelopmentEvent,
  initialProjection,
  type DevelopmentProjection,
  type JarvisEvent,
} from "../src/development/reducer.js";
import {
  DEVELOPMENT_TRANSITIONS,
  computeAuthorityEnvelopeHash,
  computeEffectHash,
  computePolicyDecisionFingerprint,
  type CapabilityEnvelope,
  type TransitionRequest,
} from "../src/development/stateMachine.js";

const missionAuthority: CapabilityEnvelope = {
  repositories: ["Benny3840RG/Jarvis"],
  branches: ["agent/governed-dev-state-machine-phase1"],
  externalEffects: ["github.merge"],
  maxRiskClass: 3,
};

function claimedToBuildingRequest(overrides: Partial<TransitionRequest> = {}): TransitionRequest {
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

function freshProjection(subjectId = "mission-1"): DevelopmentProjection {
  return initialProjection(subjectId, "CLAIMED");
}

test("committing a legal transition advances state and records latest event/projection/reducer version", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  store.seed(freshProjection());

  const outcome = store.commit(claimedToBuildingRequest(), {
    subjectId: "mission-1",
    eventId: "event-1",
    correlationId: "correlation-1",
  });

  assert.equal(outcome.kind, "COMMITTED");
  assert.equal(outcome.event.eventType, "DEV_TRANSITION_COMMITTED");
  assert.equal(outcome.projection.state, "BUILDING");
  assert.equal(outcome.projection.subjectVersion, 1);
  assert.equal(outcome.projection.projectionVersion, 1);
  assert.equal(outcome.projection.lastEventId, "event-1");
  assert.equal(outcome.projection.reducerVersion, DEVELOPMENT_REDUCER_VERSION);
});

test("a rejected commit produces a DEV_TRANSITION_REJECTED audit event but no domain-state transition", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  // The subject is really at READY -- CLAIMED_TO_BUILDING's registered
  // `from` is CLAIMED, so this is a genuine mismatch against the grounded
  // (persisted) state, not merely the request's own (now-ignored) `from`.
  store.seed(initialProjection("mission-1", "READY"));

  const outcome = store.commit(claimedToBuildingRequest(), {
    subjectId: "mission-1",
    eventId: "event-1",
    correlationId: "correlation-1",
  });

  assert.equal(outcome.kind, "REJECTED");
  assert.equal(outcome.event.eventType, "DEV_TRANSITION_REJECTED");
  assert.ok(outcome.reasons.includes("STATE_MISMATCH_CURRENT_PROJECTION"));
  // Zero authoritative state change: still READY, still version 0.
  assert.equal(outcome.projection.state, "READY");
  assert.equal(outcome.projection.subjectVersion, 0);
});

test("commit records an unknown runtime-cast transition as a durable UNKNOWN_TRANSITION rejection", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  store.seed(freshProjection());

  const outcome = store.commit(
    claimedToBuildingRequest({
      transitionId: "DEV_TRANSITION_NOT_DECLARED" as never,
    }),
    {
      subjectId: "mission-1",
      eventId: "event-unknown-transition",
      correlationId: "correlation-unknown-transition",
    },
  );

  assert.equal(outcome.kind, "REJECTED");
  assert.equal(outcome.event.eventType, "DEV_TRANSITION_REJECTED");
  assert.deepEqual(outcome.reasons, ["UNKNOWN_TRANSITION"]);
  assert.deepEqual(outcome.event.payload.reasonCodes, ["UNKNOWN_TRANSITION"]);
  assert.equal(outcome.projection.state, "CLAIMED");
  assert.equal(outcome.projection.subjectVersion, 0);
});

test("two workers racing from the same subject version cannot both commit", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  store.seed(freshProjection());

  // Both workers observed subjectVersion 0 before either committed.
  const request = claimedToBuildingRequest({ expectedSubjectVersion: 0 });

  const first = store.commit(request, {
    subjectId: "mission-1",
    eventId: "event-worker-a",
    correlationId: "correlation-a",
  });
  // Worker B's request was built against the same stale subjectVersion 0,
  // but the store's authoritative current version has since advanced to 1.
  const second = store.commit(request, {
    subjectId: "mission-1",
    eventId: "event-worker-b",
    correlationId: "correlation-b",
  });

  assert.equal(first.kind, "COMMITTED");
  assert.equal(second.kind, "REJECTED");
  assert.ok(second.reasons.includes("STATE_MISMATCH_CURRENT_PROJECTION"));
  assert.equal(store.get("mission-1")?.subjectVersion, 1);
});

test("committing with a lease records and advances the subject's known fencing token", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  store.seed(freshProjection());

  const outcome = store.commit(
    claimedToBuildingRequest({
      lease: {
        leaseToken: "lease-token-5",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-09-01T01:00:00.000Z",
        fencingToken: 5,
      },
    }),
    { subjectId: "mission-1", eventId: "event-1", correlationId: "correlation-1" },
  );

  assert.equal(outcome.kind, "COMMITTED");
  assert.equal(outcome.projection.fencingToken, 5);
  assert.equal(store.get("mission-1")?.fencingToken, 5);
});

test("a stale fencing token is rejected through the real commit boundary, not only the pure evaluator", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  // Worker A already won the claim with fencingToken 5 (e.g. after worker B's
  // earlier lease expired and A re-claimed) -- the store now knows 5 is
  // current, even though the projection is still sitting at CLAIMED.
  store.seed({ ...freshProjection(), fencingToken: 5 });

  // Worker B's stale request still carries the older token 3.
  const outcome = store.commit(
    claimedToBuildingRequest({
      workerId: "worker-b",
      lease: {
        leaseToken: "lease-token-3",
        leaseOwner: "worker-b",
        leaseExpiresAt: "2026-09-01T01:00:00.000Z",
        fencingToken: 3,
      },
    }),
    { subjectId: "mission-1", eventId: "event-worker-b", correlationId: "correlation-b" },
  );

  assert.equal(outcome.kind, "REJECTED");
  assert.ok(outcome.reasons.includes("STALE_FENCING_TOKEN"));
  // Zero authoritative state change from the rejected attempt.
  assert.equal(store.get("mission-1")?.state, "CLAIMED");
});

test("commit rejects a request whose declared source differs from the persisted projection", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  store.seed(initialProjection("mission-1", "IDEA"));

  const outcome = store.commit(claimedToBuildingRequest(), {
    subjectId: "mission-1",
    eventId: "event-stale-source",
    correlationId: "correlation-stale-source",
  });

  assert.equal(outcome.kind, "REJECTED");
  assert.deepEqual(outcome.reasons, ["STATE_MISMATCH_CURRENT_PROJECTION"]);
  assert.equal(store.get("mission-1")?.state, "IDEA");
  assert.equal(store.get("mission-1")?.subjectVersion, 0);
});

test("duplicate event ID application is idempotent on replay", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  store.seed(freshProjection());

  const outcome = store.commit(claimedToBuildingRequest(), {
    subjectId: "mission-1",
    eventId: "event-1",
    correlationId: "correlation-1",
  });
  assert.equal(outcome.kind, "COMMITTED");
  assert.equal(outcome.projection.subjectVersion, 1);

  const replay = store.replay("mission-1", outcome.event);

  assert.equal(replay.applied, false);
  assert.equal(replay.projection.subjectVersion, 1);
  assert.equal(replay.projection.projectionVersion, 1);
});

test("replay rejects a crafted completion event rather than letting it bypass the trusted Omega path", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  store.seed(initialProjection("mission-1", "MERGED"));

  const crafted: JarvisEvent = {
    eventId: "event-forged-complete",
    eventType: "DEV_TRANSITION_COMMITTED",
    eventSchemaVersion: 1,
    subjectId: "mission-1",
    transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
    committedBy: { actorType: "omega", actorId: "omega-sigma" },
    occurredAt: "2026-09-01T00:00:00.000Z",
    recordedAt: "2026-09-01T00:00:00.000Z",
    evidenceIds: [],
    correlationId: "correlation-forged-complete",
    reducerVersion: DEVELOPMENT_REDUCER_VERSION,
    payload: { from: "MERGED", to: "COMPLETE" },
  };

  const result = store.replay("mission-1", crafted);

  assert.equal(result.applied, false);
  assert.ok(result.violations.includes("UNTRUSTED_EVENT_REPLAY"));
  assert.equal(store.get("mission-1")?.state, "MERGED");
});

test("replay rejects a transition event whose subject or source does not match the current projection", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  store.seed(freshProjection());

  const crafted: JarvisEvent = {
    eventId: "event-mismatched-projection",
    eventType: "DEV_TRANSITION_COMMITTED",
    eventSchemaVersion: 1,
    subjectId: "another-mission",
    transitionId: "DEV_TRANSITION_CLAIMED_TO_BUILDING",
    committedBy: { actorType: "controller", actorId: "development-controller" },
    occurredAt: "2026-09-01T00:00:00.000Z",
    recordedAt: "2026-09-01T00:00:00.000Z",
    evidenceIds: [],
    correlationId: "correlation-mismatched-projection",
    reducerVersion: DEVELOPMENT_REDUCER_VERSION,
    payload: { from: "IDEA", to: "BUILDING" },
  };

  const result = applyDevelopmentEvent(freshProjection(), crafted, new Map());

  assert.equal(result.applied, false);
  assert.ok(result.violations.includes("EVENT_SUBJECT_MISMATCH"));
  assert.equal(store.get("mission-1")?.state, "CLAIMED");
});

test("replay rejects a changed payload for an already-seen event ID while the exact event stays idempotent", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  store.seed(freshProjection());

  const outcome = store.commit(claimedToBuildingRequest(), {
    subjectId: "mission-1",
    eventId: "event-id-payload-binding",
    correlationId: "correlation-id-payload-binding",
  });
  assert.equal(outcome.kind, "COMMITTED");

  const exactReplay = store.replay("mission-1", outcome.event);
  assert.equal(exactReplay.applied, false);
  assert.deepEqual(exactReplay.violations, []);

  const changedPayload = {
    ...outcome.event,
    payload: { ...outcome.event.payload, auditNote: "changed after commit" },
  };
  const changedReplay = store.replay("mission-1", changedPayload);

  assert.equal(changedReplay.applied, false);
  assert.ok(changedReplay.violations.includes("EVENT_ID_PAYLOAD_MISMATCH"));
  assert.equal(store.get("mission-1")?.state, "BUILDING");
  assert.equal(store.get("mission-1")?.subjectVersion, 1);
});

test("an event with an unsupported schema version fails closed without mutating the projection", () => {
  const projection = freshProjection();
  const appliedEventIds = new Map<string, string>();

  const malformed: JarvisEvent = {
    eventId: "event-bad-schema",
    eventType: "DEV_TRANSITION_COMMITTED",
    eventSchemaVersion: 999,
    subjectId: "mission-1",
    transitionId: "DEV_TRANSITION_CLAIMED_TO_BUILDING",
    committedBy: { actorType: "controller", actorId: "development-controller" },
    occurredAt: "2026-09-01T00:00:00.000Z",
    recordedAt: "2026-09-01T00:00:00.000Z",
    evidenceIds: [],
    correlationId: "correlation-1",
    reducerVersion: DEVELOPMENT_REDUCER_VERSION,
    payload: { to: "BUILDING" },
  };

  const result = applyDevelopmentEvent(projection, malformed, appliedEventIds);

  assert.equal(result.applied, false);
  assert.ok(result.violations.includes("UNSUPPORTED_EVENT_SCHEMA_VERSION"));
  assert.deepEqual(result.projection, projection);
  assert.equal(appliedEventIds.has("event-bad-schema"), false);
});

test("an event whose reducer version cannot read its schema version fails closed", () => {
  const projection = freshProjection();
  const appliedEventIds = new Map<string, string>();

  const malformed: JarvisEvent = {
    eventId: "event-bad-reducer",
    eventType: "DEV_TRANSITION_COMMITTED",
    eventSchemaVersion: 1,
    subjectId: "mission-1",
    transitionId: "DEV_TRANSITION_CLAIMED_TO_BUILDING",
    committedBy: { actorType: "controller", actorId: "development-controller" },
    occurredAt: "2026-09-01T00:00:00.000Z",
    recordedAt: "2026-09-01T00:00:00.000Z",
    evidenceIds: [],
    correlationId: "correlation-1",
    reducerVersion: "DevelopmentReducer/v999-does-not-exist",
    payload: { to: "BUILDING" },
  };

  const result = applyDevelopmentEvent(projection, malformed, appliedEventIds);

  assert.equal(result.applied, false);
  assert.ok(result.violations.includes("UNKNOWN_REDUCER_VERSION"));
  assert.deepEqual(result.projection, projection);
});

test("a committed transition's event durably records which approval authorised it", () => {
  const store = new InMemoryDevelopmentProjectionStore();
  const subjectId = "mission-merge-1";
  store.seed(initialProjection(subjectId, "READY_TO_MERGE"));

  const effectPayload = { reviewedHeadSha: "abc123" };
  const mergeDefinition = DEVELOPMENT_TRANSITIONS.DEV_TRANSITION_READY_TO_MERGE_TO_MERGED;
  const request: TransitionRequest = {
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
    mergeEvidence: {
      reviewedHeadSha: "abc123",
      currentHeadSha: "abc123",
      operationOutcome: "MERGED",
      reconciledMergedCommitSha: "def456",
    },
    approval: {
      approvalId: "approval-audit-1",
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
    },
  };

  const outcome = store.commit(request, {
    subjectId,
    eventId: "event-merge-1",
    correlationId: "correlation-merge-1",
  });

  assert.equal(outcome.kind, "COMMITTED");
  assert.equal(outcome.event.payload.approvalId, "approval-audit-1");
});
