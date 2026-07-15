import { v } from "convex/values";

export const toolActionStateValidator = v.union(
  v.literal("proposed"),
  v.literal("approved"),
  v.literal("rejected"),
);

export const toolActionActorValidator = v.union(
  v.literal("user"),
  v.literal("agent"),
  v.literal("tool"),
);

export const toolAuthorityValidator = v.union(
  v.literal("T0"),
  v.literal("T1"),
  v.literal("T2"),
  v.literal("T3"),
);

export const toolActionDocumentValidator = v.object({
  _id: v.id("toolActions"),
  _creationTime: v.number(),
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
});
