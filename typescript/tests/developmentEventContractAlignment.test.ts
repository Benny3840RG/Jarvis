import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEVELOPMENT_EVENT_TYPES,
  DEVELOPMENT_REDUCER_VERSION,
  validateEventEnvelope,
  type JarvisEvent,
} from "../src/development/events.js";

type YamlModule = { load(input: string): unknown };
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as YamlModule;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

type EventContract = {
  schema_version: number;
  contract_id: string;
  event_types: string[];
  envelope: { required_fields: string[] };
  reducer_compatibility: Record<string, { readable_event_schema_versions: number[] }>;
  idempotency: Record<string, unknown>;
  causation: Record<string, unknown>;
  transition_binding: Record<string, unknown>;
  model_invocation_receipt: Record<string, unknown>;
};

function canonicalEvents(): EventContract {
  return yaml.load(readFileSync(`${repoRoot}EVENTS.yaml`, "utf8")) as EventContract;
}

function validEvent(overrides: Partial<JarvisEvent> = {}): JarvisEvent {
  return {
    eventId: "event-1",
    eventType: "DEV_TRANSITION_COMMITTED",
    eventSchemaVersion: 1,
    subjectId: "mission-1",
    transitionId: "DEV_TRANSITION_CLAIMED_TO_BUILDING",
    requestedBy: { actorType: "worker", actorId: "worker-1" },
    evaluatedBy: { actorType: "controller", actorId: "gate-v1" },
    authorisedBy: { actorType: "controller", actorId: "controller-1" },
    committedBy: { actorType: "controller", actorId: "controller-1" },
    occurredAt: "2026-09-01T00:00:00.000Z",
    recordedAt: "2026-09-01T00:00:01.000Z",
    evidenceIds: ["evidence-1"],
    correlationId: "correlation-1",
    reducerVersion: DEVELOPMENT_REDUCER_VERSION,
    payload: {
      from: "CLAIMED",
      to: "BUILDING",
      sourceSubjectVersion: 0,
      resultingSubjectVersion: 1,
    },
    ...overrides,
  };
}

test("EVENTS.yaml is the machine-readable source for the exact Development event types and envelope", () => {
  const contract = canonicalEvents();
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.contract_id, "JARVIS_DEVELOPMENT_EVENTS_V1");
  assert.deepEqual([...DEVELOPMENT_EVENT_TYPES], contract.event_types);
  assert.deepEqual(contract.envelope.required_fields, [
    "event_id",
    "event_type",
    "event_schema_version",
    "subject_id",
    "correlation_id",
    "occurred_at",
    "recorded_at",
    "reducer_version",
    "payload",
  ]);
  assert.deepEqual(
    contract.reducer_compatibility[DEVELOPMENT_REDUCER_VERSION]?.readable_event_schema_versions,
    [1],
  );
});

test("event envelope rejects missing required values and unsupported schema/reducer compatibility", () => {
  assert.deepEqual(validateEventEnvelope(validEvent({ eventId: "" })), ["EVENT_ID_REQUIRED"]);
  assert.deepEqual(validateEventEnvelope(validEvent({ correlationId: "" })), [
    "CORRELATION_ID_REQUIRED",
  ]);
  assert.deepEqual(validateEventEnvelope(validEvent({ payload: undefined as never })), [
    "PAYLOAD_REQUIRED",
  ]);
  assert.ok(
    validateEventEnvelope(validEvent({ eventSchemaVersion: 2 })).includes(
      "UNSUPPORTED_EVENT_SCHEMA_VERSION",
    ),
  );
  assert.ok(
    validateEventEnvelope(validEvent({ reducerVersion: "DevelopmentReducer/v999" })).includes(
      "UNKNOWN_REDUCER_VERSION",
    ),
  );
});

test("event envelope rejects a self-causing event before it can enter immutable history", () => {
  const result = validateEventEnvelope(validEvent({ causationId: "event-1" }));

  assert.deepEqual(result, ["SELF_CAUSATION"]);
});

test("event contract defines immutable ID binding, transition binding, causation and trusted model usage provenance", () => {
  const contract = canonicalEvents();
  assert.equal(contract.idempotency.same_event_id_different_payload, "REJECTED");
  assert.equal(contract.transition_binding.unknown_governing_id, "REJECTED");
  assert.equal(contract.causation.prevent_self_causation, true);
  assert.equal(contract.causation.prevent_future_or_nonexistent_parent, true);
  assert.equal(contract.causation.prevent_cycles, true);
  assert.equal(
    contract.model_invocation_receipt.model_identity_authority,
    "trusted_runtime_or_provider_metadata",
  );
  assert.deepEqual(contract.model_invocation_receipt.usage_provenance, [
    "actual",
    "estimated",
    "unavailable",
  ]);
});
