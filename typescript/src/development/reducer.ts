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
import { canonicalJson } from "../actions/canonicalJson.js";
import { DEVELOPMENT_TRANSITIONS } from "./transitionRegistry.js";

export { DEVELOPMENT_REDUCER_VERSION };
export type { DevelopmentEventType, JarvisEvent };

export type DevelopmentProjection = {
  readonly subjectId: string;
  readonly state: DevelopmentState;
  readonly subjectVersion: number;
  readonly projectionVersion: number;
  readonly reducerVersion: string;
  readonly lastEventId?: string;
  /**
   * The subject's latest known lease fencing token. Advances whenever a
   * commit is accepted with a lease attached, so a subsequent stale token
   * loses even on a legitimate re-entrant transition (e.g. a repair-cycle
   * retry) where `state` itself hasn't moved.
   */
  readonly fencingToken?: number;
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

export type DevelopmentEventViolation =
  | EventEnvelopeViolation
  | "EVENT_ID_PAYLOAD_MISMATCH"
  | "EVENT_SUBJECT_MISMATCH"
  | "EVENT_TRANSITION_ID_REQUIRED"
  | "UNKNOWN_EVENT_TRANSITION"
  | "EVENT_TRANSITION_PAYLOAD_MISMATCH"
  | "EVENT_SOURCE_STATE_MISMATCH"
  | "EVENT_SOURCE_VERSION_MISMATCH"
  | "EVENT_RESULTING_VERSION_MISMATCH"
  | "OMEGA_COMPLETION_REQUIRES_AUTHORITY_PATH"
  | "UNTRUSTED_EVENT_REPLAY";

export type ApplyResult = {
  readonly projection: DevelopmentProjection;
  readonly applied: boolean;
  readonly violations: readonly DevelopmentEventViolation[];
};

type AppliedEventFingerprints = Map<string, string>;

function eventFingerprint(event: JarvisEvent): string {
  // The repository's canonical encoder makes duplicate detection independent
  // of JavaScript object-key insertion order. The event ID is only an
  // idempotency key when it remains bound to this exact durable envelope.
  return canonicalJson({
    eventId: event.eventId,
    eventType: event.eventType,
    eventSchemaVersion: event.eventSchemaVersion,
    subjectId: event.subjectId,
    ...(event.transitionId !== undefined ? { transitionId: event.transitionId } : {}),
    ...(event.requestedBy !== undefined ? { requestedBy: event.requestedBy } : {}),
    ...(event.evaluatedBy !== undefined ? { evaluatedBy: event.evaluatedBy } : {}),
    ...(event.authorisedBy !== undefined ? { authorisedBy: event.authorisedBy } : {}),
    ...(event.committedBy !== undefined ? { committedBy: event.committedBy } : {}),
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    evidenceIds: event.evidenceIds,
    correlationId: event.correlationId,
    ...(event.causationId !== undefined ? { causationId: event.causationId } : {}),
    reducerVersion: event.reducerVersion,
    payload: event.payload,
  });
}

function validateCommittedTransitionEvent(
  projection: DevelopmentProjection,
  event: JarvisEvent,
  authorityPath: "generic" | "omega",
): readonly DevelopmentEventViolation[] {
  if (event.subjectId !== projection.subjectId) return ["EVENT_SUBJECT_MISMATCH"];
  if (!event.transitionId) return ["EVENT_TRANSITION_ID_REQUIRED"];

  const definition = DEVELOPMENT_TRANSITIONS[event.transitionId];
  if (!definition) return ["UNKNOWN_EVENT_TRANSITION"];

  const from = event.payload.from;
  const to = event.payload.to;
  if (!definition.sources.includes(from as DevelopmentState) || to !== definition.target) {
    return ["EVENT_TRANSITION_PAYLOAD_MISMATCH"];
  }
  if (from !== projection.state) return ["EVENT_SOURCE_STATE_MISMATCH"];

  const sourceSubjectVersion = event.payload.sourceSubjectVersion;
  const resultingSubjectVersion = event.payload.resultingSubjectVersion;
  if (sourceSubjectVersion !== projection.subjectVersion) {
    return ["EVENT_SOURCE_VERSION_MISMATCH"];
  }
  if (resultingSubjectVersion !== projection.subjectVersion + 1) {
    return ["EVENT_RESULTING_VERSION_MISMATCH"];
  }

  // ΩΣ owns completion. This generic reducer must never be turned into a
  // second completion authority by replaying an event-shaped object; real
  // completion stays on omegaMissions.transition's trusted path.
  if (definition.authoritativeCommitter === "omega") {
    const omegaActor = { actorType: "omega", actorId: "omega-sigma" } as const;
    const hasOmegaAuthority =
      event.evaluatedBy?.actorType === omegaActor.actorType &&
      event.evaluatedBy.actorId === omegaActor.actorId &&
      event.authorisedBy?.actorType === omegaActor.actorType &&
      event.authorisedBy.actorId === omegaActor.actorId &&
      event.committedBy?.actorType === omegaActor.actorType &&
      event.committedBy.actorId === omegaActor.actorId;
    if (authorityPath !== "omega" || !hasOmegaAuthority) {
      return ["OMEGA_COMPLETION_REQUIRES_AUTHORITY_PATH"];
    }
  }

  return [];
}

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
  appliedEventFingerprints: AppliedEventFingerprints,
): ApplyResult {
  const violations = validateEventEnvelope(event);
  if (violations.length > 0) {
    return { projection, applied: false, violations };
  }

  const eventFingerprintValue = eventFingerprint(event);
  const priorFingerprint = appliedEventFingerprints.get(event.eventId);
  if (priorFingerprint !== undefined && priorFingerprint !== eventFingerprintValue) {
    return { projection, applied: false, violations: ["EVENT_ID_PAYLOAD_MISMATCH"] };
  }
  if (priorFingerprint !== undefined) {
    return { projection, applied: false, violations: [] };
  }

  if (event.eventType === "DEV_TRANSITION_COMMITTED") {
    const semanticViolations = validateCommittedTransitionEvent(projection, event, "generic");
    if (semanticViolations.length > 0) {
      return { projection, applied: false, violations: semanticViolations };
    }
  }

  appliedEventFingerprints.set(event.eventId, eventFingerprintValue);

  if (event.eventType !== "DEV_TRANSITION_COMMITTED") {
    // Audit-only events (e.g. DEV_TRANSITION_REJECTED) are durably recorded
    // and now idempotency-tracked, but never mutate the domain projection.
    return { projection, applied: true, violations: [] };
  }

  const to = event.payload.to as DevelopmentState;
  const leaseFencingToken = event.payload.leaseFencingToken as number | undefined;
  return {
    projection: {
      subjectId: projection.subjectId,
      state: to,
      subjectVersion: projection.subjectVersion + 1,
      projectionVersion: projection.projectionVersion + 1,
      reducerVersion: DEVELOPMENT_REDUCER_VERSION,
      lastEventId: event.eventId,
      fencingToken: leaseFencingToken ?? projection.fencingToken,
    },
    applied: true,
    violations: [],
  };
}

/**
 * Reducer entry point reserved for the existing trusted ΩΣ mutation. It
 * admits only the canonical Omega-owned completion transition and still
 * applies every ordinary envelope, version, source-state, and actor check.
 * Possessing an event-shaped object is therefore insufficient; the durable
 * caller remains `omegaMissions.transition` inside one Convex transaction.
 */
export function applyOmegaDevelopmentCompletionEvent(
  projection: DevelopmentProjection,
  event: JarvisEvent,
  appliedEventFingerprints: AppliedEventFingerprints,
): ApplyResult {
  const violations = validateEventEnvelope(event);
  if (violations.length > 0) return { projection, applied: false, violations };
  if (event.transitionId !== "DEV_TRANSITION_MERGED_TO_COMPLETE") {
    return {
      projection,
      applied: false,
      violations: ["OMEGA_COMPLETION_REQUIRES_AUTHORITY_PATH"],
    };
  }

  const eventFingerprintValue = eventFingerprint(event);
  const priorFingerprint = appliedEventFingerprints.get(event.eventId);
  if (priorFingerprint !== undefined && priorFingerprint !== eventFingerprintValue) {
    return { projection, applied: false, violations: ["EVENT_ID_PAYLOAD_MISMATCH"] };
  }
  if (priorFingerprint !== undefined) {
    return { projection, applied: false, violations: [] };
  }

  const semanticViolations = validateCommittedTransitionEvent(projection, event, "omega");
  if (semanticViolations.length > 0) {
    return { projection, applied: false, violations: semanticViolations };
  }

  appliedEventFingerprints.set(event.eventId, eventFingerprintValue);
  return {
    projection: {
      subjectId: projection.subjectId,
      state: "COMPLETE",
      subjectVersion: projection.subjectVersion + 1,
      projectionVersion: projection.projectionVersion + 1,
      reducerVersion: DEVELOPMENT_REDUCER_VERSION,
      lastEventId: event.eventId,
      fencingToken: projection.fencingToken,
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

/**
 * Exported so any real commit boundary (e.g. a future Convex mutation)
 * builds the identical event shape this in-memory store does, rather than
 * re-deriving event construction — the trusted commit boundary must funnel
 * through this same evaluator/reducer pair, never reimplement it.
 */
export function buildEvent(
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
  private readonly appliedEventFingerprints = new Map<string, AppliedEventFingerprints>();
  /**
   * An in-memory analogue of an authoritative event log. `replay` is only a
   * duplicate-delivery path for events already emitted by `commit`; it is not
   * an alternate command endpoint that accepts caller-crafted history.
   */
  private readonly committedEventFingerprints = new Map<string, AppliedEventFingerprints>();

  seed(projection: DevelopmentProjection): void {
    this.projections.set(projection.subjectId, projection);
    this.appliedEventFingerprints.set(projection.subjectId, new Map());
    this.committedEventFingerprints.set(projection.subjectId, new Map());
  }

  get(subjectId: string): DevelopmentProjection | undefined {
    return this.projections.get(subjectId);
  }

  commit(request: TransitionRequest, context: CommitContext): CommitOutcome {
    const current = this.projections.get(context.subjectId);
    if (!current) {
      throw new Error(`Unknown Development subject: ${context.subjectId}`);
    }

    // The public TypeScript type prevents unknown IDs at ordinary call sites,
    // but command payloads are runtime data. Let the deterministic evaluator
    // reject an unknown cast/deserialised ID and emit its audit event rather
    // than dereferencing a missing registry entry first.
    const definition = (
      DEVELOPMENT_TRANSITIONS as Record<
        string,
        (typeof DEVELOPMENT_TRANSITIONS)[keyof typeof DEVELOPMENT_TRANSITIONS] | undefined
      >
    )[request.transitionId];
    const preconditionReason =
      definition !== undefined &&
      (!definition.sources.includes(current.state) || current.state !== request.from)
        ? "STATE_MISMATCH_CURRENT_PROJECTION"
        : request.transitionId === "DEV_TRANSITION_MERGED_TO_COMPLETE"
          ? "OMEGA_COMPLETION_REQUIRES_AUTHORITY_PATH"
          : undefined;
    const evaluation = preconditionReason
      ? undefined
      : evaluateDevelopmentTransition({
          ...request,
          currentSubjectVersion: current.subjectVersion,
          currentFencingToken: current.fencingToken,
        });
    const allowed = evaluation?.allowed ?? false;
    const reasons = preconditionReason ? [preconditionReason] : evaluation!.reasons;

    const event = allowed
      ? buildEvent("DEV_TRANSITION_COMMITTED", request, context, {
          from: current.state,
          to: request.to,
          sourceSubjectVersion: current.subjectVersion,
          resultingSubjectVersion: current.subjectVersion + 1,
          ...(request.approval ? { approvalId: request.approval.approvalId } : {}),
          ...(request.lease ? { leaseFencingToken: request.lease.fencingToken } : {}),
        })
      : buildEvent("DEV_TRANSITION_REJECTED", request, context, {
          from: request.from,
          to: request.to,
          reasonCodes: reasons,
          ...(evaluation?.retryDisposition
            ? { retryDisposition: evaluation.retryDisposition }
            : {}),
        });

    const applyResult = applyDevelopmentEvent(
      current,
      event,
      this.appliedEventFingerprints.get(context.subjectId)!,
    );
    this.projections.set(context.subjectId, applyResult.projection);
    if (applyResult.applied) {
      this.committedEventFingerprints
        .get(context.subjectId)!
        .set(event.eventId, eventFingerprint(event));
    }

    return {
      kind: allowed ? "COMMITTED" : "REJECTED",
      event,
      projection: applyResult.projection,
      reasons,
    };
  }

  replay(subjectId: string, event: JarvisEvent): ApplyResult {
    const current = this.projections.get(subjectId);
    if (!current) {
      throw new Error(`Unknown Development subject: ${subjectId}`);
    }
    let appliedEventFingerprints = this.appliedEventFingerprints.get(subjectId);
    if (!appliedEventFingerprints) {
      appliedEventFingerprints = new Map();
      this.appliedEventFingerprints.set(subjectId, appliedEventFingerprints);
    }
    const committedEventFingerprints = this.committedEventFingerprints.get(subjectId);
    const committedFingerprint = committedEventFingerprints?.get(event.eventId);
    if (committedFingerprint === undefined) {
      return {
        projection: current,
        applied: false,
        violations: ["UNTRUSTED_EVENT_REPLAY"],
      };
    }
    if (committedFingerprint !== eventFingerprint(event)) {
      return {
        projection: current,
        applied: false,
        violations: ["EVENT_ID_PAYLOAD_MISMATCH"],
      };
    }
    const result = applyDevelopmentEvent(current, event, appliedEventFingerprints);
    this.projections.set(subjectId, result.projection);
    return result;
  }
}
