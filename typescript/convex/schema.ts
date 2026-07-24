import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  externalReconciliationStateValidator,
  externalReconciliationTerminalStatusValidator,
} from "./externalReconciliationValidators.js";
import {
  internalActionFamilyValidator,
  internalActionResultValidator,
} from "./internalActionValidators.js";
import {
  memoryChangeSetActorValidator,
  memoryChangeSetStateValidator,
  memoryRecordValidator,
} from "./memoryChangeSetValidators.js";
import {
  noteDomainValidator,
  noteRetentionValidator,
  noteSensitivityValidator,
} from "./noteValidators.js";
import {
  toolActionActorValidator,
  toolActionStateValidator,
  toolAuthorityValidator,
} from "./toolActionValidators.js";
import {
  toolExecutionErrorCodeValidator,
  toolExecutionStatusValidator,
} from "./toolExecutionValidators.js";
import {
  projectPreferencesValidator,
  projectRecordValidator,
  projectStatusValidator,
  recordKindValidator,
  validationCheckValidator,
} from "./totalityValidators.js";

export default defineSchema({
  tasks: defineTable({
    ownerId: v.string(),
    title: v.string(),
    completed: v.boolean(),
    category: v.string(),
    projectId: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
    revision: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_owner_and_project", ["ownerId", "projectId"]),
  reminders: defineTable({
    ownerId: v.string(),
    title: v.string(),
    due: v.optional(v.string()),
    dueRaw: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    dueTimezone: v.optional(v.string()),
    projectId: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
    revision: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_owner_and_project", ["ownerId", "projectId"]),
  internalActionResults: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    actionFamilyId: internalActionFamilyValidator,
    idempotencyKey: v.string(),
    actionFingerprint: v.string(),
    entityType: v.union(v.literal("task"), v.literal("reminder")),
    entityId: v.string(),
    result: internalActionResultValidator,
    sourceRequestId: v.string(),
    correlationId: v.string(),
    source: v.string(),
    createdAt: v.number(),
  })
    .index("by_owner_project_family_idempotency", [
      "ownerId",
      "projectId",
      "actionFamilyId",
      "idempotencyKey",
    ])
    .index("by_owner_entity", ["ownerId", "entityType", "entityId"]),
  notes: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    title: v.string(),
    body: v.string(),
    tags: v.array(v.string()),
    domain: noteDomainValidator,
    sensitivity: noteSensitivityValidator,
    retention: noteRetentionValidator,
    idempotencyKey: v.string(),
    actionFingerprint: v.string(),
    sourceRequestId: v.string(),
    correlationId: v.string(),
    source: v.string(),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_and_project_and_idempotency_key", ["ownerId", "projectId", "idempotencyKey"])
    .index("by_owner_and_project_and_updated_at", ["ownerId", "projectId", "updatedAt"]),
  assistantState: defineTable({
    ownerId: v.string(),
    key: v.string(),
    state: v.any(),
    updatedAt: v.number(),
  }).index("by_owner_key", ["ownerId", "key"]),
  projects: defineTable({
    ownerId: v.string(),
    projectKey: v.string(),
    projectName: v.string(),
    projectType: v.string(),
    status: projectStatusValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
    revision: v.number(),
    domains: v.array(v.string()),
    summary: v.string(),
    preferences: projectPreferencesValidator,
  })
    .index("by_owner_and_project_key", ["ownerId", "projectKey"])
    .index("by_owner_and_updated_at", ["ownerId", "updatedAt"]),
  projectRecords: defineTable({
    ownerId: v.string(),
    projectKey: v.string(),
    kind: recordKindValidator,
    recordId: v.string(),
    record: projectRecordValidator,
    updatedAt: v.number(),
  })
    .index("by_owner_and_project_key_and_kind", ["ownerId", "projectKey", "kind"])
    .index("by_owner_and_project_key_and_record_id", ["ownerId", "projectKey", "recordId"]),
  memoryChangeSets: defineTable({
    ownerId: v.string(),
    changeSetId: v.string(),
    requestId: v.string(),
    projectKey: v.string(),
    baseRevision: v.number(),
    state: memoryChangeSetStateValidator,
    records: v.array(memoryRecordValidator),
    rationale: v.string(),
    proposedBy: memoryChangeSetActorValidator,
    approvedBy: v.optional(v.literal("user")),
    rejectedBy: v.optional(v.literal("user")),
    rejectedReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    approvedAt: v.optional(v.number()),
    rejectedAt: v.optional(v.number()),
    appliedAt: v.optional(v.number()),
    appliedRevision: v.optional(v.number()),
  })
    .index("by_owner_and_change_set_id", ["ownerId", "changeSetId"])
    .index("by_owner_and_project_key", ["ownerId", "projectKey"])
    .index("by_owner_and_project_key_and_state", ["ownerId", "projectKey", "state"])
    .index("by_owner_and_request_id", ["ownerId", "requestId"]),
  toolActions: defineTable({
    ownerId: v.string(),
    actionId: v.string(),
    requestId: v.string(),
    projectKey: v.string(),
    baseRevision: v.number(),
    state: toolActionStateValidator,
    tool: v.string(),
    operation: v.string(),
    arguments: v.record(v.string(), v.any()),
    rationale: v.string(),
    requiredAuthority: toolAuthorityValidator,
    destructive: v.boolean(),
    idempotencyKey: v.string(),
    proposedBy: toolActionActorValidator,
    approvedBy: v.optional(v.literal("user")),
    rejectedBy: v.optional(v.literal("user")),
    rejectedReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    approvedAt: v.optional(v.number()),
    rejectedAt: v.optional(v.number()),
  })
    .index("by_owner_and_action_id", ["ownerId", "actionId"])
    .index("by_owner_and_idempotency_key", ["ownerId", "idempotencyKey"])
    .index("by_owner_and_project_key", ["ownerId", "projectKey"])
    .index("by_owner_and_project_key_and_state", ["ownerId", "projectKey", "state"])
    .index("by_owner_and_request_id", ["ownerId", "requestId"]),
  toolExecutionReceipts: defineTable({
    ownerId: v.string(),
    receiptKey: v.string(),
    receiptId: v.string(),
    actionId: v.string(),
    requestId: v.optional(v.string()),
    projectId: v.string(),
    idempotencyKey: v.string(),
    actionFingerprint: v.string(),
    effectFingerprint: v.optional(v.string()),
    tool: v.string(),
    operation: v.string(),
    actor: v.optional(toolActionActorValidator),
    approvalId: v.optional(v.string()),
    policyVersion: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    source: v.optional(v.string()),
    provider: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    providerCorrelationId: v.optional(v.string()),
    reconciliationId: v.optional(v.string()),
    status: toolExecutionStatusValidator,
    outputDigest: v.optional(v.string()),
    errorCode: v.optional(toolExecutionErrorCodeValidator),
    providerErrorCode: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_owner_and_receipt_key", ["ownerId", "receiptKey"])
    .index("by_owner_and_action_id", ["ownerId", "actionId"]),
  externalReconciliations: defineTable({
    ownerId: v.string(),
    reconciliationId: v.string(),
    executionKey: v.string(),
    actionId: v.string(),
    requestId: v.string(),
    projectId: v.string(),
    idempotencyKey: v.string(),
    actionFingerprint: v.string(),
    effectFingerprint: v.string(),
    tool: v.string(),
    operation: v.string(),
    provider: v.string(),
    providerRequestId: v.optional(v.string()),
    providerCorrelationId: v.string(),
    receiptKey: v.optional(v.string()),
    receiptId: v.optional(v.string()),
    state: externalReconciliationStateValidator,
    attemptCount: v.number(),
    nextAttemptAt: v.number(),
    leaseOwner: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    terminalStatus: v.optional(externalReconciliationTerminalStatusValidator),
    resolutionDigest: v.optional(v.string()),
    resolutionErrorCode: v.optional(v.string()),
    lastErrorCode: v.optional(v.string()),
    escalationReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    escalatedAt: v.optional(v.number()),
  })
    .index("by_owner_and_reconciliation_id", ["ownerId", "reconciliationId"])
    .index("by_owner_and_scope", ["ownerId", "projectId", "tool", "operation", "idempotencyKey"])
    .index("by_owner_and_state_and_next_attempt_at", ["ownerId", "state", "nextAttemptAt"])
    .index("by_owner_and_state_and_lease_expires_at", ["ownerId", "state", "leaseExpiresAt"])
    .index("by_owner_and_receipt_key", ["ownerId", "receiptKey"]),
  validationReports: defineTable({
    ownerId: v.string(),
    requestId: v.string(),
    scopeKey: v.string(),
    passed: v.boolean(),
    checks: v.array(validationCheckValidator),
    warnings: v.array(v.string()),
    blockingFailures: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_owner_and_request_id", ["ownerId", "requestId"])
    .index("by_owner_and_scope_key", ["ownerId", "scopeKey"]),
  auditEvents: defineTable({
    ownerId: v.string(),
    requestId: v.optional(v.string()),
    scopeKey: v.string(),
    eventType: v.string(),
    actor: v.union(v.literal("user"), v.literal("agent"), v.literal("tool")),
    payload: v.record(v.string(), v.any()),
    createdAt: v.number(),
  })
    .index("by_owner_and_scope_key", ["ownerId", "scopeKey"])
    .index("by_owner_and_request_id", ["ownerId", "requestId"]),
  builds: defineTable({
    ownerId: v.string(),
    name: v.string(),
    kind: v.string(),
    status: v.union(
      v.literal("planning"),
      v.literal("active"),
      v.literal("shelved"),
      v.literal("retired"),
    ),
    description: v.optional(v.string()),
    nickname: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  buildLogs: defineTable({
    ownerId: v.string(),
    buildId: v.string(),
    kind: v.union(
      v.literal("origin"),
      v.literal("milestone"),
      v.literal("failure"),
      v.literal("anecdote"),
      v.literal("note"),
    ),
    title: v.string(),
    body: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  upgrades: defineTable({
    ownerId: v.string(),
    buildId: v.string(),
    title: v.string(),
    reason: v.optional(v.string()),
    beforeState: v.optional(v.string()),
    afterState: v.optional(v.string()),
    outcome: v.optional(v.string()),
    parts: v.optional(v.array(v.string())),
    version: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  assets: defineTable({
    ownerId: v.string(),
    name: v.string(),
    kind: v.string(),
    serviceIntervalDays: v.optional(v.number()),
    lastServicedAt: v.optional(v.number()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  preferences: defineTable({
    ownerId: v.string(),
    key: v.string(),
    value: v.string(),
    category: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),
});
