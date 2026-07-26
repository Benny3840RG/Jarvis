import { v } from "convex/values";

export const quoteDeliveryStatusValidator = v.union(
  v.literal("pending"),
  v.literal("executing"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("indeterminate"),
  v.literal("reconciled"),
);

export const quoteDeliveryChannelValidator = v.literal("email");

export const quoteDeliveryReconciledOutcomeValidator = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
);

export const quoteDeliveryAttemptDocumentValidator = v.object({
  _id: v.id("quoteDeliveryAttempts"),
  _creationTime: v.number(),
  ownerId: v.string(),
  deliveryAttemptId: v.string(),
  quoteId: v.string(),
  revision: v.number(),
  revisionId: v.string(),
  revisionFingerprint: v.string(),
  recipient: v.string(),
  channel: quoteDeliveryChannelValidator,
  sendFingerprint: v.string(),
  idempotencyKey: v.string(),
  approvalId: v.string(),
  actionFingerprint: v.string(),
  status: quoteDeliveryStatusValidator,
  reconciledOutcome: v.optional(quoteDeliveryReconciledOutcomeValidator),
  provider: v.string(),
  providerRequestId: v.optional(v.string()),
  providerCorrelationId: v.optional(v.string()),
  reconciliationId: v.optional(v.string()),
  providerErrorCode: v.optional(v.string()),
  createdAt: v.number(),
  executionStartedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  reconciledAt: v.optional(v.number()),
  updatedAt: v.number(),
});
