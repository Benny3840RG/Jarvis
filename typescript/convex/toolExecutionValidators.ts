import { v } from "convex/values";

export const toolExecutionStatusValidator = v.union(
  v.literal("dry-run"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("timed-out"),
  v.literal("blocked"),
);

export const toolExecutionErrorCodeValidator = v.union(
  v.literal("not-authorized"),
  v.literal("not-allowlisted"),
  v.literal("invalid-arguments"),
  v.literal("timeout"),
  v.literal("failed"),
);

export const toolExecutionReceiptDocumentValidator = v.object({
  _id: v.id("toolExecutionReceipts"),
  _creationTime: v.number(),
  ownerId: v.string(),
  receiptKey: v.string(),
  receiptId: v.string(),
  actionId: v.string(),
  idempotencyKey: v.string(),
  tool: v.string(),
  operation: v.string(),
  status: toolExecutionStatusValidator,
  outputDigest: v.optional(v.string()),
  errorCode: v.optional(toolExecutionErrorCodeValidator),
  startedAt: v.number(),
  completedAt: v.number(),
  createdAt: v.number(),
});
