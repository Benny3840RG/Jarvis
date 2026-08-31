/**
 * Development projection reducer and in-memory commit boundary
 * (JARVIS Phase 1, Task 4).
 *
 * This is the kernel-level trusted commit boundary: it re-validates every
 * request through evaluateDevelopmentTransition (never trusting a caller's
 * belief about current state), builds the corresponding durable event
 * (DEV_TRANSITION_COMMITTED or the audit-only DEV_TRANSITION_REJECTED), and
 * applies it through the deterministic, idempotent reducer. It holds
 * projections in memory — the real Convex-backed transaction boundary
 * (single mutation: read -> validate -> append event -> reduce -> persist,
 * per JARVIS_EVENTS.md "Convex transaction boundary") is Task 7's job, and
 * must funnel through this same evaluator/reducer pair rather than
 * reimplementing the gate.
 */

import {
  DEVELOPMENT_REDUCER_VERSION,
  validateEventEnvelope,
  type DevelopmentEventType,
  type EventEnvelopeViolation,
  type JarvisEvent,
} from "./events.js";
import {
  evaluateDevelopmentTransition,
  type DevelopmentState,
  type TransitionRequest,
} from "./stateMachine.js";

export { DEVELOPMENT_REDUCER_VERSION };
export type { JarvisEvent };

export type DevelopmentProjection = {
  readonly subjectId: string;
  readonly state: DevelopmentState;
  readonly subjectVersion: number;
  readonly projectionVersion: number;
  readonly reducerVersion: string;
  readonly lastEventId?: string;
};

export function initialProjection(
  subjectId: string,
  state: DevelopmentState,
): DevelopmentProjection {
  return Object.freeze({
    subjectId,
    state,
    subjectVersion: 0,
    projectionVersion: 0,
    reducerVersion: DEVELOPMENT_REDUCER_VERSION,
  });
}

export type ApplyResult = {
  readonly projection: DevelopmentProjection;
  readonly applied: boolean;
  readonly violations: readonly EventEnvelopeViolation[];
};

/**
 * Deterministic, idempotent projection reducer. Applying an event whose ID
 * has already been applied for this subject is a guaranteed no-op — this is
 * the whole idempotency contract, so callers must pass the *same*
 * `appliedEventIds` set across calls for a given subject (the in-memory
 * store below does this correctly; a Convex-backed store would use an
 * indexed "seen event ID" lookup instead of an in-process Set).
 */
export function applyDevelopmentEvent(
  projection: DevelopmentProjection,
  event: JarvisEvent,
  appliedEventIds: Set<string>,
): ApplyResult {
  const violations = validateEventEnvelope(event);
  if (violations.length > 0) {
    return { projection, applied: false, violations };
  }

  if (appliedEventIds.has(event.eventId)) {
    return { projection, applied: false, violations: [] };
  }
  appliedEventIds.add(event.eventId);

  if (event.eventType !== "DEV_TRANSITION_COMMITTED") {
    // Audit-only events (e.g. DEV_TRANSITION_REJECTED) are durably recorded
    // and now idempotency-tracked, but never mutate the domain projection.
    return { projection, applied: true, violations: [] };
  }

  const to = event.payload.to as DevelopmentState;
  return {
    projection: {
      subjectId: projection.subjectId,
      state: to,
      subjectVersion: projection.subjectVersion + 1,
      projectionVersion: projection.projectionVersion + 1,
      reducerVersion: DEVELOPMENT_REDUCER_VERSION,
      lastEventId: event.eventId,
    },
    applied: true,
    violations: [],
  };
}

export type CommitContext = {
  readonly subjectId: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly evidenceIds?: readonly string[];
  readonly occurredAt?: string;
};

export type CommitOutcome = {
  readonly kind: "COMMITTED" | "REJECTED";
  readonly event: JarvisEvent;
  readonly projection: DevelopmentProjection;
  readonly reasons: readonly string[];
};

function buildEvent(
  eventType: DevelopmentEventType,
  request: TransitionRequest,
  context: CommitContext,
  payload: Record<string, unknown>,
): JarvisEvent {
  const now = context.occurredAt ?? request.now;
  return Object.freeze({
    eventId: context.eventId,
    eventType,
    eventSchemaVersion: 1,
    subjectId: context.subjectId,
    transitionId: request.transitionId,
    requestedBy: request.requestedBy,
    evaluatedBy: request.evaluatedBy,
    authorisedBy: request.authorisedBy,
    committedBy: request.committedBy,
    occurredAt: now,
    recordedAt: now,
    evidenceIds: Object.freeze([...(context.evidenceIds ?? [])]),
    correlationId: context.correlationId,
    causationId: context.causationId,
    reducerVersion: DEVELOPMENT_REDUCER_VERSION,
    payload: Object.freeze({ ...payload }),
  });
}

/**
 * In-memory Development projection store standing in for the future
 * Convex-backed transaction boundary. `commit` always re-reads its own
 * authoritative current projection — never a caller-supplied one — so a
 * request built against a stale subjectVersion is rejected even if the
 * caller never learned about the intervening commit (the same optimistic-
 * concurrency shape Convex mutations already use elsewhere in this repo).
 */
export class InMemoryDevelopmentProjectionStore {
  private readonly projections = new Map<string, DevelopmentProjection>();
  private readonly appliedEventIds = new Map<string, Set<string>>();

  seed(projection: DevelopmentProjection): void {
    this.projections.set(projection.subjectId, projection);
    this.appliedEventIds.set(projection.subjectId, new Set());
  }

  get(subjectId: string): DevelopmentProjection | undefined {
    return this.projections.get(subjectId);
  }

  commit(request: TransitionRequest, context: CommitContext): CommitOutcome {
    const current = this.projections.get(context.subjectId);
    if (!current) {
      throw new Error(`Unknown Development subject: ${context.subjectId}`);
    }

    const evaluation = evaluateDevelopmentTransition({
      ...request,
      currentSubjectVersion: current.subjectVersion,
    });

    const event = evaluation.allowed
      ? buildEvent("DEV_TRANSITION_COMMITTED", request, context, {
          from: request.from,
          to: request.to,
        })
      : buildEvent("DEV_TRANSITION_REJECTED", request, context, {
          from: request.from,
          to: request.to,
          reasonCodes: evaluation.reasons,
        });

    const applyResult = applyDevelopmentEvent(
      current,
      event,
      this.appliedEventIds.get(context.subjectId)!,
    );
    this.projections.set(context.subjectId, applyResult.projection);

    return {
      kind: evaluation.allowed ? "COMMITTED" : "REJECTED",
      event,
      projection: applyResult.projection,
      reasons: evaluation.reasons,
    };
  }

  replay(subjectId: string, event: JarvisEvent): ApplyResult {
    const current = this.projections.get(subjectId);
    if (!current) {
      throw new Error(`Unknown Development subject: ${subjectId}`);
    }
    let appliedEventIds = this.appliedEventIds.get(subjectId);
    if (!appliedEventIds) {
      appliedEventIds = new Set();
      this.appliedEventIds.set(subjectId, appliedEventIds);
    }
    const result = applyDevelopmentEvent(current, event, appliedEventIds);
    this.projections.set(subjectId, result.projection);
    return result;
  }
}
