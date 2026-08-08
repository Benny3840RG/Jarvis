import { v } from "convex/values";

import { toolAuthorityValidator } from "./toolActionValidators.js";

export const orchestrationRunStateValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("indeterminate"),
);

export const orchestrationStepStateValidator = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("indeterminate"),
);

export const orchestrationTriggerSourceValidator = v.union(
  v.literal("cli"),
  v.literal("http"),
  v.literal("mcp"),
  v.literal("scheduler"),
);

export const orchestrationFailureCodeValidator = v.union(
  v.literal("blocked"),
  v.literal("not_found"),
  v.literal("invalid_transition"),
  v.literal("unauthorised"),
  v.literal("conflict"),
  v.literal("invalid_request"),
  v.literal("dependency_failure"),
  v.literal("postcondition_failed"),
  v.literal("audit_failure"),
  v.literal("execution_budget_exceeded"),
);

export const orchestrationRecoveryStateValidator = v.union(
  v.literal("none"),
  v.literal("required"),
  v.literal("retrying"),
  v.literal("recovered"),
  v.literal("escalated"),
);

export const orchestrationRecoveryEvidenceValidator = v.object({
  kind: v.union(
    v.literal("checkpoint"),
    v.literal("restart"),
    v.literal("retry"),
    v.literal("indeterminate"),
  ),
  detail: v.string(),
  occurredAt: v.number(),
});

export const orchestrationRunDocumentValidator = v.object({
  _id: v.id("orchestrationRuns"),
  _creationTime: v.number(),
  ownerId: v.string(),
  runId: v.string(),
  triggerId: v.string(),
  triggerSource: orchestrationTriggerSourceValidator,
  triggerKind: v.string(),
  idempotencyKey: v.string(),
  requestFingerprint: v.string(),
  planFingerprint: v.string(),
  triggerPayload: v.record(v.string(), v.any()),
  authority: toolAuthorityValidator,
  policyVersion: v.string(),
  policyFingerprint: v.string(),
  nodeIds: v.array(v.string()),
  completedStepIds: v.array(v.string()),
  checkpointSequence: v.number(),
  state: orchestrationRunStateValidator,
  failureCode: v.optional(orchestrationFailureCodeValidator),
  retryCount: v.number(),
  maxRetries: v.number(),
  recoveryState: orchestrationRecoveryStateValidator,
  recoveryEvidence: v.array(orchestrationRecoveryEvidenceValidator),
  checkpointNodeId: v.optional(v.string()),
  checkpointAt: v.optional(v.number()),
  recoveryReference: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const orchestrationStepDocumentValidator = v.object({
  _id: v.id("orchestrationSteps"),
  _creationTime: v.number(),
  ownerId: v.string(),
  runId: v.string(),
  nodeId: v.string(),
  operationId: v.optional(v.string()),
  state: orchestrationStepStateValidator,
  attempt: v.number(),
  retryable: v.boolean(),
  outputDigest: v.optional(v.string()),
  failureCode: v.optional(orchestrationFailureCodeValidator),
  indeterminateReason: v.optional(v.string()),
  reconciliationId: v.optional(v.string()),
  updatedAt: v.number(),
  completedAt: v.optional(v.number()),
  leaseOwner: v.optional(v.string()),
  leaseToken: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
  nextAttemptAt: v.optional(v.number()),
});

export const orchestrationRecoveryResultValidator = v.union(
  v.object({
    status: v.literal("recovered"),
    run: orchestrationRunDocumentValidator,
    step: orchestrationStepDocumentValidator,
  }),
  v.object({
    status: v.literal("escalated"),
    run: orchestrationRunDocumentValidator,
    step: orchestrationStepDocumentValidator,
  }),
);
