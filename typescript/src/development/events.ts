/**
 * Canonical Development-domain event envelope (JARVIS Phase 1, Task 4).
 * Mirrors the envelope contract in JARVIS_EVENTS.md exactly. This module
 * only defines the shape and schema/reducer compatibility rules; reducer.ts
 * owns applying events to a projection and the commit boundary.
 */

import type { ActorRef, DevelopmentTransitionId } from "./stateMachine.js";

export type DevelopmentEventType =
  | "DEV_SPEC_VALIDATED"
  | "DEV_TRANSITION_COMMITTED"
  | "DEV_TRANSITION_REJECTED"
  | "DEV_WORKER_CLAIM_CREATED"
  | "DEV_LEASE_EXPIRED"
  | "DEV_BUILD_RESULT_RECORDED"
  | "DEV_VERIFICATION_RESULT_RECORDED"
  | "DEV_REVIEW_RESULT_RECORDED"
  | "DEV_REPAIR_REQUIRED"
  | "DEV_MERGE_ATTEMPT_STARTED"
  | "DEV_MERGE_ATTEMPT_FAILED"
  | "DEV_MERGE_ATTEMPT_INDETERMINATE"
  | "DEV_MERGE_RECEIPT_RECORDED"
  | "DEV_RECONCILIATION_OPENED"
  | "DEV_RECONCILIATION_RESOLVED"
  | "DEV_POST_MERGE_OBSERVATION_RECORDED"
  | "DEV_OMEGA_EVALUATION_RECORDED";

export type JarvisEvent = {
  readonly eventId: string;
  readonly eventType: DevelopmentEventType;
  readonly eventSchemaVersion: number;
  readonly subjectId: string;
  readonly transitionId?: DevelopmentTransitionId;
  readonly requestedBy?: ActorRef;
  readonly evaluatedBy?: ActorRef;
  readonly authorisedBy?: ActorRef;
  readonly committedBy?: ActorRef;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly evidenceIds: readonly string[];
  readonly correlationId: string;
  readonly causationId?: string;
  readonly reducerVersion: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

/** Event-schema versions the Development domain currently emits/accepts. */
export const SUPPORTED_EVENT_SCHEMA_VERSIONS: readonly number[] = Object.freeze([1]);

export const DEVELOPMENT_REDUCER_VERSION = "DevelopmentReducer/v1";

/**
 * Each reducer version declares exactly which event schema versions it can
 * read (JARVIS_EVENTS.md "Schema/reducer compatibility"). A reducer version
 * absent from this map, or a schema version not in its list, fails closed —
 * historical events are never silently reinterpreted under a new schema.
 */
const REDUCER_SCHEMA_COMPATIBILITY: Readonly<Record<string, readonly number[]>> = Object.freeze({
  [DEVELOPMENT_REDUCER_VERSION]: Object.freeze([1]),
});

export type EventEnvelopeViolation =
  | "UNSUPPORTED_EVENT_SCHEMA_VERSION"
  | "UNKNOWN_REDUCER_VERSION"
  | "REDUCER_CANNOT_READ_EVENT_SCHEMA_VERSION";

/**
 * Validates the event envelope/schema-reducer compatibility only. This does
 * not validate business-rule admissibility (that's evaluateDevelopmentTransition)
 * or authenticate the caller (that's the trusted commit boundary in reducer.ts).
 */
export function validateEventEnvelope(event: JarvisEvent): EventEnvelopeViolation[] {
  const violations: EventEnvelopeViolation[] = [];

  if (!SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(event.eventSchemaVersion)) {
    violations.push("UNSUPPORTED_EVENT_SCHEMA_VERSION");
  }

  const compatibleSchemas = REDUCER_SCHEMA_COMPATIBILITY[event.reducerVersion];
  if (!compatibleSchemas) {
    violations.push("UNKNOWN_REDUCER_VERSION");
  } else if (!compatibleSchemas.includes(event.eventSchemaVersion)) {
    violations.push("REDUCER_CANNOT_READ_EVENT_SCHEMA_VERSION");
  }

  return violations;
}
