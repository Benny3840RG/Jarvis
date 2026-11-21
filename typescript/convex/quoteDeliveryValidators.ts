import { v, type Infer } from "convex/values";

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

/**
 * One step of a delivery attempt's lifecycle, appended by the mutation that made
 * it. `immutableIdApplied` appears only on `provider-reference`: whether the
 * provider confirmed it applied `Prefer: IdType="ImmutableId"` to the draft.
 */
export const quoteDeliveryTransitionValidator = v.object({
  event: v.union(
    v.literal("pending"),
    v.literal("executing"),
    v.literal("provider-reference"),
    v.literal("indeterminate"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("reconciled"),
  ),
  at: v.number(),
  immutableIdApplied: v.optional(v.boolean()),
});

export type QuoteDeliveryTransition = Infer<typeof quoteDeliveryTransitionValidator>;

/**
 * The lifecycle has at most five steps; the bound leaves room for a re-bound
 * provider reference and keeps the array far below Convex document limits.
 */
export const MAX_QUOTE_DELIVERY_TRANSITIONS = 8;

export function appendQuoteDeliveryTransition(
  existing: readonly QuoteDeliveryTransition[] | undefined,
  transition: QuoteDeliveryTransition,
): QuoteDeliveryTransition[] {
  const history = existing ?? [];
  if (history.length >= MAX_QUOTE_DELIVERY_TRANSITIONS) {
    throw new Error("Quote delivery attempt transition history is full.");
  }
  return [...history, transition];
}

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
  transitions: v.optional(v.array(quoteDeliveryTransitionValidator)),
});
