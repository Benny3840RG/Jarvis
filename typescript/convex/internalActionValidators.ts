import { v } from "convex/values";

export const internalActionFamilyValidator = v.union(
  v.literal("AM-004"),
  v.literal("AM-005"),
  v.literal("AM-006"),
  v.literal("AM-007"),
);

export const taskActionResultValidator = v.object({
  kind: v.literal("task"),
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  category: v.string(),
  completed: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  revision: v.number(),
  completedAt: v.optional(v.number()),
});

export const reminderActionResultValidator = v.object({
  kind: v.literal("reminder"),
  id: v.string(),
  projectId: v.string(),
  title: v.string(),
  dueRaw: v.optional(v.string()),
  dueAt: v.optional(v.number()),
  dueTimezone: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  revision: v.number(),
  cancelledAt: v.optional(v.number()),
});

export const internalActionResultValidator = v.union(
  taskActionResultValidator,
  reminderActionResultValidator,
);

export const internalActionResultDocumentValidator = v.object({
  _id: v.id("internalActionResults"),
  _creationTime: v.number(),
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
});
