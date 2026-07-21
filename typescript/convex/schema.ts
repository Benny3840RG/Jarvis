import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  memoryChangeSetActorValidator,
  memoryChangeSetStateValidator,
  memoryRecordValidator,
} from "./memoryChangeSetValidators.js";
import {
  toolActionActorValidator,
  toolActionStateValidator,
  toolAuthorityValidator,
} from "./toolActionValidators.js";
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
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  reminders: defineTable({
    ownerId: v.string(),
    title: v.string(),
    due: v.optional(v.string()),
    dueRaw: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    dueTimezone: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"]),
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
});
