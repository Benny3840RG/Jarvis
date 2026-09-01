import { v } from "convex/values";

import { toolExecutionReceiptDocumentValidator } from "./toolExecutionValidators.js";
import { safetyBindingValidator } from "./safetyBindingValidators.js";

export const externalReconciliationStateValidator = v.union(
  v.literal("observing"),
  v.literal("pending"),
  v.literal("claimed"),
  v.literal("resolved"),
  v.literal("escalated"),
);

export const externalReconciliationTerminalStatusValidator = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("no-effect"),
);

export const externalReconciliationDocumentValidator = v.object({
  _id: v.id("externalReconciliations"),
  _creationTime: v.number(),
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
  safetyBinding: v.optional(safetyBindingValidator),
});

export const externalReconciliationEnvelopeValidator = v.object({
  reconciliation: externalReconciliationDocumentValidator,
  receipt: v.union(toolExecutionReceiptDocumentValidator, v.null()),
});

export const externalReconciliationClaimValidator = v.object({
  reconciliation: externalReconciliationDocumentValidator,
  receipt: toolExecutionReceiptDocumentValidator,
});
