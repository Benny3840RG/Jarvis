import { v } from "convex/values";

import {
  applyDevelopmentEvent,
  applyOmegaDevelopmentCompletionEvent,
  buildEvent,
  type DevelopmentProjection,
  type JarvisEvent,
} from "../src/development/reducer.js";
import { canonicalJson } from "../src/actions/canonicalJson.js";
import {
  computeAuthorityEnvelopeHash,
  computePolicyDecisionFingerprint,
  evaluateDevelopmentTransition,
  type TransitionEvaluation,
  type TransitionRequest,
} from "../src/development/stateMachine.js";
import { DEVELOPMENT_TRANSITIONS } from "../src/development/transitionRegistry.js";
import { fingerprintToolAction, fingerprintToolEffect } from "../src/actions/toolExecution.js";
import type { ToolAction } from "../src/actions/toolActions.js";
import type { OmegaCompletionInput } from "../src/omega/policy.js";
import { resolveTrustedModelProfile } from "../src/development/modelResourceGovernance.js";
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
const DEVELOPMENT_STATE_CONTROLLER = Object.freeze({
  actorType: "controller" as const,
  actorId: "development-state-controller",
});
const LEASE_REQUIRED_TRANSITIONS = new Set([
  "DEV_TRANSITION_READY_TO_CLAIMED",
  "DEV_TRANSITION_CLAIMED_TO_BUILDING",
  "DEV_TRANSITION_BUILDING_TO_VERIFYING",
  "DEV_TRANSITION_REPAIR_REQUIRED_TO_BUILDING",
]);

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

async function findOrchestrationRun(ctx: QueryCtx | MutationCtx, ownerId: string, runId: string) {
  return ctx.db
    .query("orchestrationRuns")
    .withIndex("by_owner_and_run_id", (q) => q.eq("ownerId", ownerId).eq("runId", runId))
    .unique();
}

async function findOrchestrationStep(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  runId: string,
  nodeId: string,
) {
  return ctx.db
    .query("orchestrationSteps")
    .withIndex("by_owner_and_run_id_and_node_id", (q) =>
      q.eq("ownerId", ownerId).eq("runId", runId).eq("nodeId", nodeId),
    )
    .unique();
}

function authorityRiskClass(authority: "T0" | "T1" | "T2" | "T3"): number {
  return Number(authority.slice(1));
}

function toolActionForFingerprint(action: Doc<"toolActions">): ToolAction {
  return {
    actionId: action.actionId,
    requestId: action.requestId,
    projectId: action.projectKey,
    baseRevision: action.baseRevision,
    state: action.state,
    tool: action.tool,
    operation: action.operation,
    arguments: action.arguments,
    rationale: action.rationale,
    requiredAuthority: action.requiredAuthority,
    destructive: action.destructive,
    idempotencyKey: action.idempotencyKey,
    proposedBy: action.proposedBy,
    createdAt: new Date(action.createdAt).toISOString(),
    updatedAt: new Date(action.updatedAt).toISOString(),
  };
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

function optionalField<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function requestFingerprint(input: {
  subjectId: string;
  requestId: string;
  correlationId: string;
  causationId?: string;
  transitionId: string;
  to: string;
  requestedBy: unknown;
  evaluatedBy?: unknown;
  authorisedBy?: unknown;
  committedBy?: unknown;
  workerId?: string;
  lease?: unknown;
  missionAuthority?: unknown;
  workerAuthority?: unknown;
  branch?: string;
  repository?: string;
  riskClass?: number;
  modelSuggestedRisk?: number;
  evidenceDerivedRisk?: number;
  approval?: unknown;
  effectPayload?: unknown;
  mergeEvidence?: unknown;
  reconciliationEvidence?: unknown;
  mergeReceiptKey?: string;
  expectedSubjectVersion?: number;
}): string {
  return canonicalJson({
    subjectId: input.subjectId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    ...optionalField("causationId", input.causationId),
    transitionId: input.transitionId,
    to: input.to,
    requestedBy: input.requestedBy,
    ...optionalField("evaluatedBy", input.evaluatedBy),
    ...optionalField("authorisedBy", input.authorisedBy),
    ...optionalField("committedBy", input.committedBy),
    ...optionalField("workerId", input.workerId),
    ...optionalField("lease", input.lease),
    ...optionalField("missionAuthority", input.missionAuthority),
    ...optionalField("workerAuthority", input.workerAuthority),
    ...optionalField("branch", input.branch),
    ...optionalField("repository", input.repository),
    ...optionalField("riskClass", input.riskClass),
    ...optionalField("modelSuggestedRisk", input.modelSuggestedRisk),
    ...optionalField("evidenceDerivedRisk", input.evidenceDerivedRisk),
    ...optionalField("approval", input.approval),
    ...optionalField("effectPayload", input.effectPayload),
    ...optionalField("mergeEvidence", input.mergeEvidence),
    ...optionalField("reconciliationEvidence", input.reconciliationEvidence),
    ...optionalField("mergeReceiptKey", input.mergeReceiptKey),
    ...optionalField("expectedSubjectVersion", input.expectedSubjectVersion),
  });
}

function eventFingerprint(event: ReturnType<typeof buildEvent>): string {
  return canonicalJson({
    eventId: event.eventId,
    eventType: event.eventType,
    eventSchemaVersion: event.eventSchemaVersion,
    subjectId: event.subjectId,
    ...optionalField("transitionId", event.transitionId),
    ...optionalField("requestedBy", event.requestedBy),
    ...optionalField("evaluatedBy", event.evaluatedBy),
    ...optionalField("authorisedBy", event.authorisedBy),
    ...optionalField("committedBy", event.committedBy),
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    evidenceIds: event.evidenceIds,
    correlationId: event.correlationId,
    ...optionalField("causationId", event.causationId),
    reducerVersion: event.reducerVersion,
    payload: event.payload,
  });
}

async function appendRejectionAudit(
  ctx: MutationCtx,
  input: {
    ownerId: string;
    requestId: string;
    subjectId: string;
    eventId: string;
    transitionId: string;
    reasonCodes: readonly string[];
    canonicalRequestFingerprint: string;
    attemptedCausationId?: string;
  },
): Promise<void> {
  await ctx.db.insert("auditEvents", {
    ownerId: input.ownerId,
    requestId: input.requestId,
    scopeKey: input.subjectId,
    eventType: "development.transition.rejected",
    actor: "agent",
    payload: {
      eventId: input.eventId,
      transitionId: input.transitionId,
      reasonCodes: [...input.reasonCodes],
      canonicalRequestFingerprint: input.canonicalRequestFingerprint,
      ...optionalField("attemptedCausationId", input.attemptedCausationId),
    },
    createdAt: Date.now(),
  });
}

/**
 * Projects an already-admitted ΩΣ completion into the Development event log
 * and projection. This is intentionally a helper, not a public mutation: it
 * is callable only from `omegaMissions.transition` in the same Convex
 * transaction that evaluates and commits Omega completion.
 */
export async function projectOmegaDevelopmentCompletion(
  ctx: MutationCtx,
  input: {
    ownerId: string;
    missionId: string;
    evidenceIds: readonly string[];
    completionInput: OmegaCompletionInput;
    now: number;
  },
): Promise<void> {
  const subject = await findSubject(ctx, input.ownerId, input.missionId);
  // Omega also governs non-development missions. Absence of a same-ID
  // Development subject means there is no Development projection to update.
  if (!subject) return;
  if (subject.omegaMissionId !== input.missionId) return;
  if (subject.state !== "MERGED") {
    throw new Error("Development subject must be MERGED before Omega completion.");
  }

  const eventId = `omega-completion:${input.missionId}`;
  const requestId = eventId;
  const correlationId = eventId;
  const occurredAt = new Date(input.now).toISOString();
  const omegaActor = { actorType: "omega" as const, actorId: "omega-sigma" };
  const request: TransitionRequest = {
    transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
    from: "MERGED",
    to: "COMPLETE",
    now: occurredAt,
    requestedBy: DEVELOPMENT_STATE_CONTROLLER,
    evaluatedBy: omegaActor,
    authorisedBy: omegaActor,
    committedBy: omegaActor,
    subjectId: input.missionId,
    omegaCompletionInput: input.completionInput,
    expectedSubjectVersion: subject.subjectVersion,
    currentSubjectVersion: subject.subjectVersion,
  };
  const event = buildEvent(
    "DEV_TRANSITION_COMMITTED",
    request,
    {
      subjectId: input.missionId,
      eventId,
      correlationId,
      evidenceIds: [...input.evidenceIds].sort(),
      occurredAt,
    },
    {
      from: "MERGED",
      to: "COMPLETE",
      sourceSubjectVersion: subject.subjectVersion,
      resultingSubjectVersion: subject.subjectVersion + 1,
      omegaMissionId: input.missionId,
    },
  );
  const projectionResult = applyOmegaDevelopmentCompletionEvent(
    toProjection(subject),
    event,
    new Map(),
  );
  if (!projectionResult.applied || projectionResult.violations.length > 0) {
    throw new Error(
      `Omega Development projection denied: ${projectionResult.violations.join(", ")}.`,
    );
  }

  const existing = await ctx.db
    .query("developmentEvents")
    .withIndex("by_owner_and_subject_id_and_event_id", (q) =>
      q.eq("ownerId", input.ownerId).eq("subjectId", input.missionId).eq("eventId", eventId),
    )
    .unique();
  if (existing) throw new Error("Omega Development completion event already exists.");

  const canonicalRequestFingerprint = canonicalJson({
    requestId,
    transitionId: request.transitionId,
    subjectId: input.missionId,
    evidenceIds: event.evidenceIds,
    completionInput: input.completionInput,
  });
  await ctx.db.insert("developmentEvents", {
    ownerId: input.ownerId,
    subjectId: input.missionId,
    eventId: event.eventId,
    requestId,
    canonicalRequestFingerprint,
    canonicalEventFingerprint: eventFingerprint(event),
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
    reducerVersion: event.reducerVersion,
    payload: event.payload,
    createdAt: input.now,
  });
  await ctx.db.patch("developmentSubjects", subject._id, {
    state: projectionResult.projection.state,
    subjectVersion: projectionResult.projection.subjectVersion,
    projectionVersion: projectionResult.projection.projectionVersion,
    reducerVersion: projectionResult.projection.reducerVersion,
    lastEventId: projectionResult.projection.lastEventId,
    updatedAt: input.now,
  });
}

export const create = mutation({
  args: {
    serviceToken: v.string(),
    subjectId: v.string(),
    orchestrationRunId: v.string(),
    orchestrationNodeId: v.string(),
    repository: v.string(),
    branch: v.string(),
  },
  returns: developmentSubjectDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const subjectId = cleanRequired(args.subjectId, "Development subject ID");
    const orchestrationRunId = cleanRequired(args.orchestrationRunId, "Orchestration run ID");
    const orchestrationNodeId = cleanRequired(args.orchestrationNodeId, "Orchestration node ID");
    const repository = cleanRequired(args.repository, "Development repository");
    const branch = cleanRequired(args.branch, "Development branch");

    const existing = await findSubject(ctx, ownerId, subjectId);
    if (existing) {
      if (
        existing.orchestrationRunId !== orchestrationRunId ||
        existing.orchestrationNodeId !== orchestrationNodeId ||
        existing.omegaMissionId !== subjectId ||
        existing.repository !== repository ||
        existing.branch !== branch
      ) {
        throw new Error("Development subject already exists with a different immutable binding.");
      }
      return existing;
    }

    const run = await findOrchestrationRun(ctx, ownerId, orchestrationRunId);
    const step = await findOrchestrationStep(ctx, ownerId, orchestrationRunId, orchestrationNodeId);
    if (!run || !step) {
      throw new Error("Development subject requires an existing orchestration run and node.");
    }
    if (run.authority !== "T2" && run.authority !== "T3") {
      throw new Error("Development mission requires T2 or T3 orchestration authority.");
    }

    const now = Date.now();
    const id = await ctx.db.insert("developmentSubjects", {
      ownerId,
      subjectId,
      state: "IDEA",
      subjectVersion: 0,
      projectionVersion: 0,
      reducerVersion: DEVELOPMENT_REDUCER_VERSION,
      orchestrationRunId,
      orchestrationNodeId,
      omegaMissionId: subjectId,
      repository,
      branch,
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

export const recordModelInvocation = mutation({
  args: {
    serviceToken: v.string(),
    subjectId: v.string(),
    eventId: v.string(),
    correlationId: v.string(),
    workUnitId: v.string(),
    purpose: v.string(),
    provider: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedInputTokens: v.optional(v.number()),
    contextSize: v.optional(v.number()),
    latencyMs: v.number(),
    retryCount: v.number(),
    estimatedCost: v.number(),
    costProvenance: v.union(
      v.literal("VERIFIED_PROVIDER"),
      v.literal("ESTIMATED"),
      v.literal("UNAVAILABLE"),
    ),
    failureReason: v.optional(v.string()),
    escalationDecision: v.union(v.literal("none"), v.literal("escalated"), v.literal("downgraded")),
    escalationReason: v.optional(v.string()),
    workerId: v.optional(v.string()),
  },
  returns: developmentEventDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const subjectId = cleanRequired(args.subjectId, "Development subject ID");
    const eventId = cleanRequired(args.eventId, "Model invocation event ID");
    const correlationId = cleanRequired(args.correlationId, "Correlation ID");
    const workUnitId = cleanRequired(args.workUnitId, "Model work-unit ID");
    const purpose = cleanRequired(args.purpose, "Model invocation purpose");
    const provider = cleanRequired(args.provider, "Model provider");
    const model = cleanRequired(args.model, "Model name");
    requireSubject(await findSubject(ctx, ownerId, subjectId), subjectId);
    if (!resolveTrustedModelProfile({ provider, model })) {
      throw new Error("Model identity is absent from the trusted model registry.");
    }
    const counts = [
      ["inputTokens", args.inputTokens],
      ["outputTokens", args.outputTokens],
      ["latencyMs", args.latencyMs],
      ["retryCount", args.retryCount],
      ...(args.cachedInputTokens === undefined
        ? []
        : [["cachedInputTokens", args.cachedInputTokens] as const]),
      ...(args.contextSize === undefined ? [] : [["contextSize", args.contextSize] as const]),
    ] as const;
    for (const [label, value] of counts) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer.`);
      }
    }
    if (!Number.isFinite(args.estimatedCost) || args.estimatedCost < 0) {
      throw new Error("estimatedCost must be a non-negative finite number.");
    }
    if (args.retryCount > 10) throw new Error("Model retry count exceeds the hard safety bound.");

    const payload = {
      missionId: subjectId,
      workUnitId,
      purpose,
      provider,
      model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      ...optionalField("cachedInputTokens", args.cachedInputTokens),
      ...optionalField("contextSize", args.contextSize),
      latencyMs: args.latencyMs,
      retryCount: args.retryCount,
      estimatedCost: args.estimatedCost,
      costProvenance: args.costProvenance,
      ...optionalField("failureReason", args.failureReason?.trim() || undefined),
      escalationDecision: args.escalationDecision,
      ...optionalField("escalationReason", args.escalationReason?.trim() || undefined),
      ...optionalField("workerId", args.workerId?.trim() || undefined),
    };
    const canonicalRequestFingerprint = canonicalJson({
      subjectId,
      eventId,
      correlationId,
      payload,
    });
    const existing = await ctx.db
      .query("developmentEvents")
      .withIndex("by_owner_and_subject_id_and_event_id", (q) =>
        q.eq("ownerId", ownerId).eq("subjectId", subjectId).eq("eventId", eventId),
      )
      .unique();
    if (existing) {
      if (existing.canonicalRequestFingerprint !== canonicalRequestFingerprint) {
        throw new Error("Model invocation event ID already exists with different contents.");
      }
      return existing;
    }

    const now = Date.now();
    const occurredAt = new Date(now).toISOString();
    const event: JarvisEvent = {
      eventId,
      eventType: "DEV_MODEL_INVOCATION_RECORDED",
      eventSchemaVersion: 1,
      subjectId,
      occurredAt,
      recordedAt: occurredAt,
      evidenceIds: [],
      correlationId,
      reducerVersion: DEVELOPMENT_REDUCER_VERSION,
      payload,
    };
    const id = await ctx.db.insert("developmentEvents", {
      ownerId,
      subjectId,
      eventId,
      requestId: eventId,
      canonicalRequestFingerprint,
      canonicalEventFingerprint: eventFingerprint(event),
      eventType: event.eventType,
      eventSchemaVersion: event.eventSchemaVersion,
      occurredAt,
      recordedAt: occurredAt,
      evidenceIds: [],
      correlationId,
      reducerVersion: DEVELOPMENT_REDUCER_VERSION,
      payload,
      createdAt: now,
    });
    const created = await ctx.db.get("developmentEvents", id);
    if (!created) throw new Error("Model invocation event persistence failed.");
    return created;
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
    requestId: v.string(),
    correlationId: v.string(),
    causationId: v.optional(v.string()),
    transitionId: developmentTransitionIdValidator,
    to: developmentStateValidator,
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
    mergeReceiptKey: v.optional(v.string()),
    expectedSubjectVersion: v.optional(v.number()),
  },
  returns: developmentCommitOutcomeValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const subjectId = cleanRequired(args.subjectId, "Development subject ID");
    const eventId = cleanRequired(args.eventId, "Event ID");
    const requestId = cleanRequired(args.requestId, "Request ID");
    const correlationId = cleanRequired(args.correlationId, "Correlation ID");
    const trustedNow = new Date().toISOString();
    const causationId = args.causationId
      ? cleanRequired(args.causationId, "Causation ID")
      : undefined;

    const subject = requireSubject(await findSubject(ctx, ownerId, subjectId), subjectId);
    const canonicalRequestFingerprint = requestFingerprint({
      ...args,
      subjectId,
      requestId,
      correlationId,
      ...optionalField("causationId", causationId),
    });

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
      if (existingEvent.canonicalRequestFingerprint === canonicalRequestFingerprint) {
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
      await appendRejectionAudit(ctx, {
        ownerId,
        requestId,
        subjectId,
        eventId,
        transitionId: args.transitionId,
        reasonCodes: ["IDEMPOTENCY_EVENT_ID_CONFLICT"],
        canonicalRequestFingerprint,
        attemptedCausationId: causationId,
      });
      return {
        kind: "REJECTED" as const,
        subject,
        event: existingEvent,
        reasons: ["IDEMPOTENCY_EVENT_ID_CONFLICT"],
      };
    }

    let validCausationId: string | undefined;
    let causationReason: string | undefined;
    if (causationId !== undefined) {
      if (causationId === eventId) {
        causationReason = "CAUSATION_SELF_REFERENCE";
      } else {
        const parent = await ctx.db
          .query("developmentEvents")
          .withIndex("by_owner_and_subject_id_and_event_id", (q) =>
            q.eq("ownerId", ownerId).eq("subjectId", subjectId).eq("eventId", causationId),
          )
          .unique();
        if (!parent) causationReason = "CAUSATION_PARENT_NOT_FOUND";
        else validCausationId = causationId;
      }
    }

    const existingRequest = await ctx.db
      .query("developmentEvents")
      .withIndex("by_owner_and_subject_id_and_request_id", (q) =>
        q.eq("ownerId", ownerId).eq("subjectId", subjectId).eq("requestId", requestId),
      )
      .unique();
    if (existingRequest?.canonicalRequestFingerprint === canonicalRequestFingerprint) {
      return {
        kind: (existingRequest.eventType === "DEV_TRANSITION_COMMITTED"
          ? "COMMITTED"
          : "REJECTED") as "COMMITTED" | "REJECTED",
        subject,
        event: existingRequest,
        reasons: (existingRequest.payload.reasonCodes as string[] | undefined) ?? [],
        retryDisposition: existingRequest.payload.retryDisposition as
          "RESUME_SAME_OPERATION" | "NEW_EXECUTION_REQUIRED" | "NO_RETRY" | undefined,
      };
    }
    if (existingRequest) {
      await appendRejectionAudit(ctx, {
        ownerId,
        requestId,
        subjectId,
        eventId,
        transitionId: args.transitionId,
        reasonCodes: ["IDEMPOTENCY_REQUEST_ID_CONFLICT"],
        canonicalRequestFingerprint,
        attemptedCausationId: causationId,
      });
      return {
        kind: "REJECTED" as const,
        subject,
        event: existingRequest,
        reasons: ["IDEMPOTENCY_REQUEST_ID_CONFLICT"],
      };
    }
    const currentFencingToken = subject.fencingToken;
    const leaseRequired = LEASE_REQUIRED_TRANSITIONS.has(args.transitionId);
    const bindingComplete =
      subject.orchestrationRunId !== undefined &&
      subject.orchestrationNodeId !== undefined &&
      subject.repository !== undefined &&
      subject.branch !== undefined;
    const orchestrationRun = bindingComplete
      ? await findOrchestrationRun(ctx, ownerId, subject.orchestrationRunId!)
      : null;
    const orchestrationStep = bindingComplete
      ? await findOrchestrationStep(
          ctx,
          ownerId,
          subject.orchestrationRunId!,
          subject.orchestrationNodeId!,
        )
      : null;
    const submittedLease = args.lease;
    const orchestrationFencingToken = orchestrationStep?.leaseFencingToken;
    const trustedLease =
      orchestrationStep?.leaseOwner !== undefined &&
      orchestrationStep.leaseToken !== undefined &&
      orchestrationStep.leaseExpiresAt !== undefined &&
      orchestrationFencingToken !== undefined
        ? {
            leaseOwner: orchestrationStep.leaseOwner,
            leaseToken: orchestrationStep.leaseToken,
            leaseExpiresAt: new Date(orchestrationStep.leaseExpiresAt).toISOString(),
            fencingToken: orchestrationFencingToken,
          }
        : undefined;
    const trustedAuthority =
      orchestrationRun && bindingComplete
        ? {
            repositories: [subject.repository!],
            branches: [subject.branch!],
            externalEffects:
              orchestrationRun.authority === "T2" || orchestrationRun.authority === "T3"
                ? ["github.merge"]
                : [],
            maxRiskClass: authorityRiskClass(orchestrationRun.authority),
          }
        : undefined;
    const activeTrustedLease = leaseRequired ? trustedLease : undefined;
    const mergeReceiptKey = args.mergeReceiptKey?.trim();
    const mergeReceipt =
      args.to === "MERGED" && mergeReceiptKey
        ? await ctx.db
            .query("toolExecutionReceipts")
            .withIndex("by_owner_and_receipt_key", (q) =>
              q.eq("ownerId", ownerId).eq("receiptKey", mergeReceiptKey),
            )
            .unique()
        : null;
    const mergeAction = mergeReceipt
      ? await ctx.db
          .query("toolActions")
          .withIndex("by_owner_and_action_id", (q) =>
            q.eq("ownerId", ownerId).eq("actionId", mergeReceipt.actionId),
          )
          .unique()
      : null;
    const mergeReconciliation = mergeReceipt?.reconciliationId
      ? await ctx.db
          .query("externalReconciliations")
          .withIndex("by_owner_and_reconciliation_id", (q) =>
            q.eq("ownerId", ownerId).eq("reconciliationId", mergeReceipt.reconciliationId!),
          )
          .unique()
      : null;
    const mergeArguments = mergeAction?.arguments;
    const mergeActionFingerprintInput = mergeAction
      ? toolActionForFingerprint(mergeAction)
      : undefined;
    const reviewedHeadSha =
      typeof mergeArguments?.reviewedHeadSha === "string"
        ? mergeArguments.reviewedHeadSha.toLowerCase()
        : undefined;
    const mergeAuthorityHash = trustedAuthority
      ? computeAuthorityEnvelopeHash(trustedAuthority)
      : undefined;
    const trustedMergeReason =
      args.to !== "MERGED"
        ? undefined
        : !mergeReceiptKey
          ? "MERGE_RECEIPT_REQUIRED"
          : !mergeReceipt
            ? "MERGE_RECEIPT_NOT_FOUND"
            : !mergeAction
              ? "MERGE_ACTION_NOT_FOUND"
              : mergeAction.tool !== "github" ||
                  mergeAction.operation !== "merge-pull-request" ||
                  mergeAction.projectKey !== subjectId ||
                  mergeReceipt.projectId !== subjectId
                ? "MERGE_ACTION_SUBJECT_MISMATCH"
                : mergeAction.approvedBy !== "user" || mergeAction.approvedAt === undefined
                  ? "MERGE_ACTION_NOT_APPROVED"
                  : mergeAction.requiredAuthority !== "T3" ||
                      mergeAction.destructive !== true ||
                      mergeAction.consumptionPolicy !== "single-use"
                    ? "MERGE_ACTION_AUTHORITY_INVALID"
                    : mergeAction.singleUseClaimId !== mergeReceipt.idempotencyKey
                      ? "MERGE_EXECUTION_INTENT_NOT_BOUND"
                      : mergeReceipt.status !== "succeeded" ||
                          mergeReceipt.provider !== "github-rest-v1" ||
                          mergeReceipt.approvalId !== mergeAction.actionId ||
                          mergeReceipt.effectFingerprint === undefined
                        ? "MERGE_RECEIPT_NOT_AUTHORITATIVE"
                        : !mergeActionFingerprintInput ||
                            mergeReceipt.actionFingerprint !==
                              fingerprintToolAction(mergeActionFingerprintInput) ||
                            mergeReceipt.effectFingerprint !==
                              fingerprintToolEffect(mergeActionFingerprintInput)
                          ? "MERGE_RECEIPT_FINGERPRINT_MISMATCH"
                          : !mergeReconciliation ||
                              mergeReconciliation.state !== "resolved" ||
                              mergeReconciliation.terminalStatus !== "succeeded" ||
                              mergeReconciliation.effectFingerprint !==
                                mergeReceipt.effectFingerprint ||
                              mergeReconciliation.provider !== "github-rest-v1"
                            ? "MERGE_RECONCILIATION_NOT_PROVEN"
                            : mergeArguments?.subjectId !== subjectId ||
                                mergeArguments?.transitionId !==
                                  "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED" ||
                                mergeArguments?.repository !== subject.repository ||
                                mergeArguments?.baseBranch !== subject.branch ||
                                reviewedHeadSha === undefined ||
                                !/^[0-9a-f]{40}$/.test(reviewedHeadSha)
                              ? "MERGE_EFFECT_BINDING_MISMATCH"
                              : mergeArguments?.authorityEnvelopeHash !== mergeAuthorityHash
                                ? "MERGE_AUTHORITY_BINDING_MISMATCH"
                                : !orchestrationRun ||
                                    mergeArguments?.policyDecisionFingerprint !==
                                      orchestrationRun.policyFingerprint ||
                                    mergeReceipt.policyVersion !==
                                      orchestrationRun.policyFingerprint
                                  ? "APPROVAL_STALE_POLICY_CONTEXT"
                                  : typeof mergeArguments?.effectiveRisk !== "number" ||
                                      mergeArguments.effectiveRisk < 4
                                    ? "MERGE_RISK_BINDING_INVALID"
                                    : undefined;
    const trustedMergeApproval =
      trustedMergeReason === undefined &&
      mergeAction &&
      mergeReceipt?.effectFingerprint &&
      reviewedHeadSha &&
      mergeAuthorityHash
        ? {
            approvalId: mergeAction.actionId,
            actorType: "operator" as const,
            actorId: "tool-action-approver",
            maxRiskClass: Number(mergeArguments!.effectiveRisk),
            subjectId,
            transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED" as const,
            proposalHash: mergeReceipt.actionFingerprint,
            approvedSha: reviewedHeadSha,
            effectHash: mergeReceipt.effectFingerprint,
            authorityEnvelopeHash: mergeAuthorityHash,
            effectiveRisk: Number(mergeArguments!.effectiveRisk),
            policyDecisionFingerprint: computePolicyDecisionFingerprint(
              DEVELOPMENT_TRANSITIONS.DEV_TRANSITION_READY_TO_MERGE_TO_MERGED,
            ),
          }
        : undefined;
    const orchestrationPreconditionReason = !leaseRequired
      ? undefined
      : !bindingComplete
        ? "ORCHESTRATION_BINDING_REQUIRED"
        : !orchestrationRun || !orchestrationStep
          ? "ORCHESTRATION_CLAIM_NOT_FOUND"
          : orchestrationRun.state !== "running" || orchestrationStep.state !== "running"
            ? "ORCHESTRATION_CLAIM_NOT_ACTIVE"
            : !submittedLease || !trustedLease
              ? "ORCHESTRATION_LEASE_REQUIRED"
              : submittedLease.fencingToken < trustedLease.fencingToken
                ? "STALE_FENCING_TOKEN"
                : submittedLease.fencingToken !== trustedLease.fencingToken
                  ? "LEASE_FENCING_TOKEN_MISMATCH"
                  : submittedLease.leaseToken !== trustedLease.leaseToken ||
                      args.workerId !== trustedLease.leaseOwner
                    ? "ORCHESTRATION_LEASE_NOT_CURRENT"
                    : orchestrationStep.leaseExpiresAt! <= Date.now()
                      ? "LEASE_EXPIRED"
                      : undefined;
    const preconditionReason =
      args.transitionId === "DEV_TRANSITION_MERGED_TO_COMPLETE"
        ? "OMEGA_COMPLETION_REQUIRES_AUTHORITY_PATH"
        : orchestrationPreconditionReason
          ? orchestrationPreconditionReason
          : trustedMergeReason
            ? trustedMergeReason
            : undefined;

    const request: TransitionRequest = {
      transitionId: args.transitionId,
      // Derived from the persisted subject, never accepted from the
      // caller -- matching omegaMissions.transition's own pattern of
      // deriving from-state from the document, not a client field.
      from: subject.state,
      to: args.to,
      now: trustedNow,
      requestedBy: activeTrustedLease
        ? { actorType: "worker", actorId: activeTrustedLease.leaseOwner }
        : DEVELOPMENT_STATE_CONTROLLER,
      // Commit/evaluation authority is created only by this trusted service
      // boundary; caller-provided role strings are retained in the command
      // fingerprint but never become durable authority labels.
      evaluatedBy: DEVELOPMENT_STATE_CONTROLLER,
      authorisedBy: DEVELOPMENT_STATE_CONTROLLER,
      committedBy: DEVELOPMENT_STATE_CONTROLLER,
      workerId: activeTrustedLease?.leaseOwner,
      subjectId,
      lease: activeTrustedLease,
      missionAuthority: trustedAuthority,
      workerAuthority: trustedAuthority,
      branch: subject.branch,
      repository: subject.repository,
      riskClass: args.riskClass,
      modelSuggestedRisk: args.modelSuggestedRisk,
      evidenceDerivedRisk: args.evidenceDerivedRisk,
      approval: args.to === "MERGED" ? trustedMergeApproval : args.approval,
      effectPayload: args.effectPayload,
      mergeEvidence:
        args.to === "MERGED" && reviewedHeadSha
          ? {
              reviewedHeadSha,
              currentHeadSha: reviewedHeadSha,
              operationOutcome: "MERGED",
            }
          : args.mergeEvidence,
      reconciliationEvidence: args.reconciliationEvidence,
      expectedSubjectVersion: args.expectedSubjectVersion,
      currentSubjectVersion: subject.subjectVersion,
      currentFencingToken: orchestrationFencingToken ?? currentFencingToken,
    };

    const evaluation: TransitionEvaluation =
      preconditionReason || causationReason
        ? {
            allowed: false,
            outcome: "REJECTED",
            reasons: [preconditionReason ?? causationReason!],
          }
        : evaluateDevelopmentTransition(request);
    // A rejected command may name a self/nonexistent causal parent. That is
    // evidence about the rejected *attempt*, not a valid causal edge in
    // authoritative event history, so only a verified prior parent is kept.
    const commitContext = { subjectId, eventId, correlationId, causationId: validCausationId };

    const event = evaluation.allowed
      ? buildEvent("DEV_TRANSITION_COMMITTED", request, commitContext, {
          from: request.from,
          to: request.to,
          sourceSubjectVersion: subject.subjectVersion,
          resultingSubjectVersion: subject.subjectVersion + 1,
          ...(request.approval ? { approvalId: request.approval.approvalId } : {}),
          ...(request.lease ? { leaseFencingToken: request.lease.fencingToken } : {}),
          ...(mergeReceiptKey ? { mergeReceiptKey } : {}),
        })
      : buildEvent("DEV_TRANSITION_REJECTED", request, commitContext, {
          from: request.from,
          to: request.to,
          reasonCodes: evaluation.reasons,
          ...(evaluation.retryDisposition ? { retryDisposition: evaluation.retryDisposition } : {}),
        });

    const applyResult = applyDevelopmentEvent(toProjection(subject), event, new Map());
    if (applyResult.violations.length > 0) {
      throw new Error(
        `Development reducer refused generated event: ${applyResult.violations.join(", ")}.`,
      );
    }

    const insertedEventId = await ctx.db.insert("developmentEvents", {
      ownerId,
      subjectId,
      eventId: event.eventId,
      requestId,
      canonicalRequestFingerprint,
      canonicalEventFingerprint: eventFingerprint(event),
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
    } else {
      await appendRejectionAudit(ctx, {
        ownerId,
        requestId,
        subjectId,
        eventId,
        transitionId: args.transitionId,
        reasonCodes: evaluation.reasons,
        canonicalRequestFingerprint,
        attemptedCausationId: causationId,
      });
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
