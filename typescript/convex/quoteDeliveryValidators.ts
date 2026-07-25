import { v } from "convex/values";

import {
  QuoteDeliveryStateConflictError,
  type QuoteDeliveryAttempt,
  type QuoteDeliveryStatus,
} from "../src/quotes/quoteLifecycle.js";

export const quoteDeliveryStatusValidator = v.union(
  v.literal("pending"),
  v.literal("executing"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("indeterminate"),
  v.literal("reconciled"),
);

export const quoteDeliveryOutcomeValidator = v.union(v.literal("succeeded"), v.literal("failed"));

export const quoteDeliveryChannelValidator = v.literal("email");

export const quoteDeliveryDocumentValidator = v.object({
  _id: v.id("quoteDeliveries"),
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
  reconciledOutcome: v.optional(quoteDeliveryOutcomeValidator),
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

function requireStatus(actual: QuoteDeliveryStatus, expected: QuoteDeliveryStatus): void {
  if (actual !== expected) {
    throw new QuoteDeliveryStateConflictError(
      `Quote delivery attempt is ${actual}, expected ${expected}.`,
    );
  }
}

export type BuildQuoteDeliveryAttemptInput = {
  ownerId: string;
  deliveryAttemptId: string;
  quoteId: string;
  revision: number;
  revisionId: string;
  revisionFingerprint: string;
  recipient: string;
  channel: "email";
  sendFingerprint: string;
  idempotencyKey: string;
  approvalId: string;
  actionFingerprint: string;
  provider: string;
  now: number;
};

export function buildQuoteDeliveryAttempt(
  input: BuildQuoteDeliveryAttemptInput,
): QuoteDeliveryAttempt {
  return {
    deliveryAttemptId: input.deliveryAttemptId,
    ownerId: input.ownerId,
    quoteId: input.quoteId,
    revision: input.revision,
    revisionId: input.revisionId,
    revisionFingerprint: input.revisionFingerprint,
    recipient: input.recipient,
    channel: input.channel,
    sendFingerprint: input.sendFingerprint,
    idempotencyKey: input.idempotencyKey,
    approvalId: input.approvalId,
    actionFingerprint: input.actionFingerprint,
    status: "pending",
    provider: input.provider,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function markQuoteDeliveryExecuting(
  attempt: QuoteDeliveryAttempt,
  now: number,
): QuoteDeliveryAttempt {
  requireStatus(attempt.status, "pending");
  return { ...attempt, status: "executing", executionStartedAt: now, updatedAt: now };
}

export function bindQuoteDeliveryProviderReference(input: {
  attempt: QuoteDeliveryAttempt;
  providerRequestId: string;
  providerCorrelationId?: string;
  reconciliationId?: string;
  now: number;
}): QuoteDeliveryAttempt {
  requireStatus(input.attempt.status, "executing");
  const next: QuoteDeliveryAttempt = {
    ...input.attempt,
    providerRequestId: input.providerRequestId,
    updatedAt: input.now,
  };
  if (input.providerCorrelationId !== undefined) {
    next.providerCorrelationId = input.providerCorrelationId;
  }
  if (input.reconciliationId !== undefined) {
    next.reconciliationId = input.reconciliationId;
  }
  return next;
}

export function completeQuoteDelivery(input: {
  attempt: QuoteDeliveryAttempt;
  outcome: "succeeded" | "failed";
  providerErrorCode?: string;
  now: number;
}): QuoteDeliveryAttempt {
  requireStatus(input.attempt.status, "executing");
  const next: QuoteDeliveryAttempt = {
    ...input.attempt,
    status: input.outcome,
    completedAt: input.now,
    updatedAt: input.now,
  };
  if (input.providerErrorCode !== undefined) next.providerErrorCode = input.providerErrorCode;
  return next;
}

export function markQuoteDeliveryIndeterminate(input: {
  attempt: QuoteDeliveryAttempt;
  reconciliationId: string;
  providerErrorCode?: string;
  now: number;
}): QuoteDeliveryAttempt {
  requireStatus(input.attempt.status, "executing");
  const next: QuoteDeliveryAttempt = {
    ...input.attempt,
    status: "indeterminate",
    reconciliationId: input.reconciliationId,
    updatedAt: input.now,
  };
  if (input.providerErrorCode !== undefined) next.providerErrorCode = input.providerErrorCode;
  return next;
}

export function reconcileQuoteDelivery(input: {
  attempt: QuoteDeliveryAttempt;
  reconciliationId: string;
  outcome: "succeeded" | "failed";
  providerErrorCode?: string;
  now: number;
}): QuoteDeliveryAttempt {
  requireStatus(input.attempt.status, "indeterminate");
  if (input.attempt.reconciliationId !== input.reconciliationId) {
    throw new QuoteDeliveryStateConflictError(
      "The reconciliation ID does not match the pending indeterminate delivery attempt.",
    );
  }
  const next: QuoteDeliveryAttempt = {
    ...input.attempt,
    status: "reconciled",
    reconciledOutcome: input.outcome,
    reconciledAt: input.now,
    updatedAt: input.now,
  };
  if (input.providerErrorCode !== undefined) next.providerErrorCode = input.providerErrorCode;
  return next;
}
