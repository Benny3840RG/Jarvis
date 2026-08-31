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
import type { CapabilityEnvelope, TransitionRequest } from "../src/development/stateMachine.js";

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
  store.seed(freshProjection());

  const outcome = store.commit(claimedToBuildingRequest({ from: "READY" }), {
    subjectId: "mission-1",
    eventId: "event-1",
    correlationId: "correlation-1",
  });

  assert.equal(outcome.kind, "REJECTED");
  assert.equal(outcome.event.eventType, "DEV_TRANSITION_REJECTED");
  assert.ok(outcome.reasons.includes("STATE_MISMATCH"));
  // Zero authoritative state change: still CLAIMED, still version 0.
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
  assert.ok(second.reasons.includes("STALE_SUBJECT_VERSION"));
  assert.equal(store.get("mission-1")?.subjectVersion, 1);
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

test("an event with an unsupported schema version fails closed without mutating the projection", () => {
  const projection = freshProjection();
  const appliedEventIds = new Set<string>();

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
  const appliedEventIds = new Set<string>();

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
