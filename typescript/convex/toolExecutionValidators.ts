import { v } from "convex/values";

export const toolExecutionStatusValidator = v.union(
  v.literal("dry-run"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("indeterminate"),
  v.literal("blocked"),
);

export const toolExecutionErrorCodeValidator = v.union(
  v.literal("not-authorized"),
  v.literal("not-allowlisted"),
  v.literal("invalid-arguments"),
  v.literal("indeterminate"),
  v.literal("failed"),
  v.literal("fingerprint-mismatch"),
);

export const toolExecutionActorValidator = v.union(
  v.literal("user"),
  v.literal("agent"),
  v.literal("tool"),
);

export const toolExecutionReceiptDocumentValidator = v.object({
  _id: v.id("toolExecutionReceipts"),
  _creationTime: v.number(),
  ownerId: v.string(),
  receiptKey: v.string(),
  receiptId: v.string(),
  actionId: v.string(),
  requestId: v.string(),
  projectId: v.string(),
  idempotencyKey: v.string(),
  actionFingerprint: v.string(),
  tool: v.string(),
  operation: v.string(),
  actor: toolExecutionActorValidator,
  approvalId: v.optional(v.string()),
  policyVersion: v.string(),
  correlationId: v.string(),
  source: v.string(),
  status: toolExecutionStatusValidator,
  outputDigest: v.optional(v.string()),
  errorCode: v.optional(toolExecutionErrorCodeValidator),
  startedAt: v.number(),
  completedAt: v.number(),
  createdAt: v.number(),
});
