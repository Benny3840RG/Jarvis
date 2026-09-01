import { v } from "convex/values";

export const developmentStateValidator = v.union(
  v.literal("IDEA"),
  v.literal("SPECIFIED"),
  v.literal("READY"),
  v.literal("CLAIMED"),
  v.literal("BUILDING"),
  v.literal("VERIFYING"),
  v.literal("REPAIR_REQUIRED"),
  v.literal("REVIEW"),
  v.literal("READY_TO_MERGE"),
  v.literal("MERGED"),
  v.literal("RECONCILIATION_OPEN"),
  v.literal("ABORTED"),
  v.literal("COMPLETE"),
);

export const developmentTransitionIdValidator = v.union(
  v.literal("DEV_TRANSITION_SPECIFIED_TO_READY"),
  v.literal("DEV_TRANSITION_READY_TO_CLAIMED"),
  v.literal("DEV_TRANSITION_CLAIMED_TO_BUILDING"),
  v.literal("DEV_TRANSITION_BUILDING_TO_VERIFYING"),
  v.literal("DEV_TRANSITION_VERIFYING_TO_REPAIR_REQUIRED"),
  v.literal("DEV_TRANSITION_REPAIR_REQUIRED_TO_BUILDING"),
  v.literal("DEV_TRANSITION_VERIFYING_TO_REVIEW"),
  v.literal("DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED"),
  v.literal("DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE"),
  v.literal("DEV_TRANSITION_READY_TO_MERGE_TO_MERGED"),
  v.literal("DEV_TRANSITION_MERGED_TO_RECONCILIATION_OPEN"),
  v.literal("DEV_TRANSITION_RECONCILIATION_OPEN_TO_MERGED"),
  v.literal("DEV_TRANSITION_MERGED_TO_COMPLETE"),
  v.literal("DEV_TRANSITION_BUILDING_TO_ABORTED"),
);

export const developmentActorTypeValidator = v.union(
  v.literal("operator"),
  v.literal("control-plane"),
  v.literal("controller"),
  v.literal("worker"),
  v.literal("model"),
  v.literal("provider"),
  v.literal("omega"),
  v.literal("reconciler"),
);

export const developmentActorRefValidator = v.object({
  actorType: developmentActorTypeValidator,
  actorId: v.string(),
});

export const developmentLeaseValidator = v.object({
  leaseToken: v.string(),
  leaseOwner: v.string(),
  leaseExpiresAt: v.string(),
  fencingToken: v.number(),
});

export const developmentCapabilityEnvelopeValidator = v.object({
  repositories: v.array(v.string()),
  branches: v.array(v.string()),
  externalEffects: v.array(v.string()),
  maxRiskClass: v.number(),
});

export const developmentApprovalValidator = v.object({
  approvalId: v.string(),
  actorType: developmentActorTypeValidator,
  actorId: v.string(),
  maxRiskClass: v.number(),
  subjectId: v.string(),
  transitionId: developmentTransitionIdValidator,
  proposalHash: v.string(),
  approvedSha: v.optional(v.string()),
  effectHash: v.string(),
  authorityEnvelopeHash: v.string(),
  effectiveRisk: v.number(),
  policyDecisionFingerprint: v.string(),
});

export const developmentMergeOperationOutcomeValidator = v.union(
  v.literal("MERGED"),
  v.literal("REJECTED"),
  v.literal("FAILED"),
  v.literal("INDETERMINATE"),
);

export const developmentMergeEvidenceValidator = v.object({
  reviewedHeadSha: v.string(),
  currentHeadSha: v.string(),
  reconciledMergedCommitSha: v.optional(v.string()),
  operationOutcome: v.optional(developmentMergeOperationOutcomeValidator),
  retryable: v.optional(v.boolean()),
});

export const developmentReconciliationEvidenceValidator = v.object({
  externallyObserved: v.boolean(),
  observedOutcome: v.union(
    v.literal("MERGED"),
    v.literal("NOT_MERGED"),
    v.literal("STILL_UNKNOWN"),
  ),
  observationSource: v.string(),
});

export const developmentSubjectDocumentValidator = v.object({
  _id: v.id("developmentSubjects"),
  _creationTime: v.number(),
  ownerId: v.string(),
  subjectId: v.string(),
  state: developmentStateValidator,
  subjectVersion: v.number(),
  projectionVersion: v.number(),
  reducerVersion: v.string(),
  lastEventId: v.optional(v.string()),
  fencingToken: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const developmentEventTypeValidator = v.union(
  v.literal("DEV_SPEC_VALIDATED"),
  v.literal("DEV_TRANSITION_COMMITTED"),
  v.literal("DEV_TRANSITION_REJECTED"),
  v.literal("DEV_WORKER_CLAIM_CREATED"),
  v.literal("DEV_LEASE_EXPIRED"),
  v.literal("DEV_BUILD_RESULT_RECORDED"),
  v.literal("DEV_VERIFICATION_RESULT_RECORDED"),
  v.literal("DEV_REVIEW_RESULT_RECORDED"),
  v.literal("DEV_REPAIR_REQUIRED"),
  v.literal("DEV_MERGE_ATTEMPT_STARTED"),
  v.literal("DEV_MERGE_ATTEMPT_FAILED"),
  v.literal("DEV_MERGE_ATTEMPT_INDETERMINATE"),
  v.literal("DEV_MERGE_RECEIPT_RECORDED"),
  v.literal("DEV_RECONCILIATION_OPENED"),
  v.literal("DEV_RECONCILIATION_RESOLVED"),
  v.literal("DEV_POST_MERGE_OBSERVATION_RECORDED"),
  v.literal("DEV_OMEGA_EVALUATION_RECORDED"),
);

export const developmentEventDocumentValidator = v.object({
  _id: v.id("developmentEvents"),
  _creationTime: v.number(),
  ownerId: v.string(),
  subjectId: v.string(),
  eventId: v.string(),
  eventType: developmentEventTypeValidator,
  eventSchemaVersion: v.number(),
  transitionId: v.optional(v.string()),
  requestedBy: v.optional(developmentActorRefValidator),
  evaluatedBy: v.optional(developmentActorRefValidator),
  authorisedBy: v.optional(developmentActorRefValidator),
  committedBy: v.optional(developmentActorRefValidator),
  occurredAt: v.string(),
  recordedAt: v.string(),
  evidenceIds: v.array(v.string()),
  correlationId: v.string(),
  causationId: v.optional(v.string()),
  reducerVersion: v.string(),
  payload: v.record(v.string(), v.any()),
  createdAt: v.number(),
});

export const developmentCommitOutcomeValidator = v.object({
  kind: v.union(v.literal("COMMITTED"), v.literal("REJECTED")),
  subject: developmentSubjectDocumentValidator,
  event: developmentEventDocumentValidator,
  reasons: v.array(v.string()),
  retryDisposition: v.optional(
    v.union(
      v.literal("RESUME_SAME_OPERATION"),
      v.literal("NEW_EXECUTION_REQUIRED"),
      v.literal("NO_RETRY"),
    ),
  ),
});
