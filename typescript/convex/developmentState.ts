import { v } from "convex/values";

import {
  applyDevelopmentEvent,
  buildEvent,
  type DevelopmentProjection,
} from "../src/development/reducer.js";
import {
  evaluateDevelopmentTransition,
  type TransitionRequest,
} from "../src/development/stateMachine.js";
import { requireOwner } from "./authHelpers.js";
import {
  developmentActorRefValidator,
  developmentApprovalValidator,
  developmentCapabilityEnvelopeValidator,
  developmentCommitOutcomeValidator,
  developmentEventDocumentValidator,
  developmentLeaseValidator,
  developmentMergeEvidenceValidator,
  developmentReconciliationEvidenceValidator,
  developmentStateValidator,
  developmentSubjectDocumentValidator,
  developmentTransitionIdValidator,
} from "./developmentValidators.js";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";

const DEVELOPMENT_REDUCER_VERSION = "DevelopmentReducer/v1";

function cleanRequired(value: string, label: string, maxLength = 200): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} cannot be empty.`);
  if (cleaned.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
  return cleaned;
}

async function findSubject(ctx: QueryCtx | MutationCtx, ownerId: string, subjectId: string) {
  return ctx.db
    .query("developmentSubjects")
    .withIndex("by_owner_and_subject_id", (q) =>
      q.eq("ownerId", ownerId).eq("subjectId", subjectId),
    )
    .unique();
}

function requireSubject(subject: Doc<"developmentSubjects"> | null, subjectId: string) {
  if (!subject) throw new Error(`Development subject does not exist: ${subjectId}.`);
  return subject;
}

function toProjection(subject: Doc<"developmentSubjects">): DevelopmentProjection {
  return {
    subjectId: subject.subjectId,
    state: subject.state,
    subjectVersion: subject.subjectVersion,
    projectionVersion: subject.projectionVersion,
    reducerVersion: subject.reducerVersion,
    lastEventId: subject.lastEventId,
    fencingToken: subject.fencingToken,
  };
}

export const create = mutation({
  args: {
    serviceToken: v.string(),
    subjectId: v.string(),
    initialState: developmentStateValidator,
  },
  returns: developmentSubjectDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const subjectId = cleanRequired(args.subjectId, "Development subject ID");

    const existing = await findSubject(ctx, ownerId, subjectId);
    if (existing) {
      if (existing.state !== args.initialState) {
        throw new Error("Development subject ID already exists with a different initial state.");
      }
      return existing;
    }

    const now = Date.now();
    const id = await ctx.db.insert("developmentSubjects", {
      ownerId,
      subjectId,
      state: args.initialState,
      subjectVersion: 0,
      projectionVersion: 0,
      reducerVersion: DEVELOPMENT_REDUCER_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get("developmentSubjects", id);
    if (!created) throw new Error("Development subject creation failed.");
    return created;
  },
});

export const get = query({
  args: { serviceToken: v.string(), subjectId: v.string() },
  returns: v.union(developmentSubjectDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return findSubject(ctx, ownerId, args.subjectId.trim());
  },
});

export const listEvents = query({
  args: { serviceToken: v.string(), subjectId: v.string() },
  returns: v.array(developmentEventDocumentValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const subjectId = args.subjectId.trim();
    return ctx.db
      .query("developmentEvents")
      .withIndex("by_owner_and_subject_id_and_created_at", (q) =>
        q.eq("ownerId", ownerId).eq("subjectId", subjectId),
      )
      .order("asc")
      .take(1000);
  },
});

/**
 * The real, Convex-backed trusted commit boundary. Reuses
 * `evaluateDevelopmentTransition` (the pure kernel) and `buildEvent`/
 * `applyDevelopmentEvent` (the reducer) verbatim -- this function's own
 * logic is limited to authentication, fresh reads, idempotency, and
 * persistence, exactly as `JARVIS_EVENTS.md`'s "Convex transaction
 * boundary" describes: read current state, validate, append event, reduce,
 * persist, all inside one mutation (Convex's serializable OCC), never
 * calling an external provider from inside it.
 *
 * `DEV_TRANSITION_MERGED_TO_COMPLETE` is deliberately rejected here rather
 * than accepted: real ΩΣ completion must be committed through
 * `convex/omegaMissions.ts#transition`, gated by its own real evidence/
 * criteria/proof requirements -- this generic mutation must not become a
 * second completion-commit path (JARVIS-018). That integration is tracked,
 * not silently skipped.
 */
export const commit = mutation({
  args: {
    serviceToken: v.string(),
    subjectId: v.string(),
    eventId: v.string(),
    correlationId: v.string(),
    causationId: v.optional(v.string()),
    transitionId: developmentTransitionIdValidator,
    to: developmentStateValidator,
    now: v.string(),
    requestedBy: developmentActorRefValidator,
    evaluatedBy: v.optional(developmentActorRefValidator),
    authorisedBy: v.optional(developmentActorRefValidator),
    committedBy: developmentActorRefValidator,
    workerId: v.optional(v.string()),
    lease: v.optional(developmentLeaseValidator),
    missionAuthority: v.optional(developmentCapabilityEnvelopeValidator),
    workerAuthority: v.optional(developmentCapabilityEnvelopeValidator),
    branch: v.optional(v.string()),
    repository: v.optional(v.string()),
    riskClass: v.optional(v.number()),
    modelSuggestedRisk: v.optional(v.number()),
    evidenceDerivedRisk: v.optional(v.number()),
    approval: v.optional(developmentApprovalValidator),
    effectPayload: v.optional(v.record(v.string(), v.any())),
    mergeEvidence: v.optional(developmentMergeEvidenceValidator),
    reconciliationEvidence: v.optional(developmentReconciliationEvidenceValidator),
    expectedSubjectVersion: v.optional(v.number()),
  },
  returns: developmentCommitOutcomeValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    if (args.transitionId === "DEV_TRANSITION_MERGED_TO_COMPLETE") {
      throw new Error(
        "MERGED_TO_COMPLETE is not committable through developmentState.commit -- " +
          "real Omega completion must go through omegaMissions.transition (Task 13, not yet integrated).",
      );
    }
    const subjectId = cleanRequired(args.subjectId, "Development subject ID");
    const eventId = cleanRequired(args.eventId, "Event ID");
    const correlationId = cleanRequired(args.correlationId, "Correlation ID");

    const subject = requireSubject(await findSubject(ctx, ownerId, subjectId), subjectId);

    const existingEvent = await ctx.db
      .query("developmentEvents")
      .withIndex("by_owner_and_subject_id_and_event_id", (q) =>
        q.eq("ownerId", ownerId).eq("subjectId", subjectId).eq("eventId", eventId),
      )
      .unique();
    if (existingEvent) {
      // Idempotent replay: the same event ID was already durably recorded
      // for this subject. Return the prior outcome verbatim rather than
      // re-evaluating -- a second application must never change the
      // projection again.
      return {
        kind: (existingEvent.eventType === "DEV_TRANSITION_COMMITTED"
          ? "COMMITTED"
          : "REJECTED") as "COMMITTED" | "REJECTED",
        subject,
        event: existingEvent,
        reasons: (existingEvent.payload.reasonCodes as string[] | undefined) ?? [],
        retryDisposition: existingEvent.payload.retryDisposition as
          "RESUME_SAME_OPERATION" | "NEW_EXECUTION_REQUIRED" | "NO_RETRY" | undefined,
      };
    }

    const request: TransitionRequest = {
      transitionId: args.transitionId,
      // Derived from the persisted subject, never accepted from the
      // caller -- matching omegaMissions.transition's own pattern of
      // deriving from-state from the document, not a client field.
      from: subject.state,
      to: args.to,
      now: args.now,
      requestedBy: args.requestedBy,
      evaluatedBy: args.evaluatedBy,
      authorisedBy: args.authorisedBy,
      committedBy: args.committedBy,
      workerId: args.workerId,
      subjectId,
      lease: args.lease,
      missionAuthority: args.missionAuthority,
      workerAuthority: args.workerAuthority,
      branch: args.branch,
      repository: args.repository,
      riskClass: args.riskClass,
      modelSuggestedRisk: args.modelSuggestedRisk,
      evidenceDerivedRisk: args.evidenceDerivedRisk,
      approval: args.approval,
      effectPayload: args.effectPayload,
      mergeEvidence: args.mergeEvidence,
      reconciliationEvidence: args.reconciliationEvidence,
      expectedSubjectVersion: args.expectedSubjectVersion,
      currentSubjectVersion: subject.subjectVersion,
      currentFencingToken: subject.fencingToken,
    };

    const evaluation = evaluateDevelopmentTransition(request);
    const commitContext = { subjectId, eventId, correlationId, causationId: args.causationId };

    const event = evaluation.allowed
      ? buildEvent("DEV_TRANSITION_COMMITTED", request, commitContext, {
          from: request.from,
          to: request.to,
          ...(request.approval ? { approvalId: request.approval.approvalId } : {}),
          ...(request.lease ? { leaseFencingToken: request.lease.fencingToken } : {}),
        })
      : buildEvent("DEV_TRANSITION_REJECTED", request, commitContext, {
          from: request.from,
          to: request.to,
          reasonCodes: evaluation.reasons,
          ...(evaluation.retryDisposition ? { retryDisposition: evaluation.retryDisposition } : {}),
        });

    const applyResult = applyDevelopmentEvent(toProjection(subject), event, new Set());

    const insertedEventId = await ctx.db.insert("developmentEvents", {
      ownerId,
      subjectId,
      eventId: event.eventId,
      eventType: event.eventType,
      eventSchemaVersion: event.eventSchemaVersion,
      transitionId: event.transitionId,
      requestedBy: event.requestedBy,
      evaluatedBy: event.evaluatedBy,
      authorisedBy: event.authorisedBy,
      committedBy: event.committedBy,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      evidenceIds: [...event.evidenceIds],
      correlationId: event.correlationId,
      causationId: event.causationId,
      reducerVersion: event.reducerVersion,
      payload: { ...event.payload },
      createdAt: Date.now(),
    });
    const insertedEvent = await ctx.db.get("developmentEvents", insertedEventId);
    if (!insertedEvent) throw new Error("Development event persistence failed.");

    let updatedSubject = subject;
    if (evaluation.allowed) {
      const now = Date.now();
      await ctx.db.patch("developmentSubjects", subject._id, {
        state: applyResult.projection.state,
        subjectVersion: applyResult.projection.subjectVersion,
        projectionVersion: applyResult.projection.projectionVersion,
        reducerVersion: applyResult.projection.reducerVersion,
        lastEventId: applyResult.projection.lastEventId,
        fencingToken: applyResult.projection.fencingToken,
        updatedAt: now,
      });
      const refreshed = await ctx.db.get("developmentSubjects", subject._id);
      if (!refreshed) throw new Error("Development subject update failed.");
      updatedSubject = refreshed;
    }

    return {
      kind: (evaluation.allowed ? "COMMITTED" : "REJECTED") as "COMMITTED" | "REJECTED",
      subject: updatedSubject,
      event: insertedEvent,
      reasons: [...evaluation.reasons],
      retryDisposition: evaluation.retryDisposition,
    };
  },
});
