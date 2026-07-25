import { v } from "convex/values";

import { QuoteDeliverySendConflictError } from "../src/quotes/quoteLifecycle.js";
import { requireOwner } from "./authHelpers.js";
import {
  bindQuoteDeliveryProviderReference,
  buildQuoteDeliveryAttempt,
  completeQuoteDelivery,
  markQuoteDeliveryExecuting,
  markQuoteDeliveryIndeterminate,
  quoteDeliveryChannelValidator,
  quoteDeliveryDocumentValidator,
  quoteDeliveryOutcomeValidator,
  reconcileQuoteDelivery,
} from "./quoteDeliveryValidators.js";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";

function cleanRequiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

function validatedRevision(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Quote revision must be a positive integer.");
  }
  return value;
}

async function findBySendScope(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  quoteId: string,
  revision: number,
  recipient: string,
  channel: "email",
): Promise<Doc<"quoteDeliveries"> | null> {
  return ctx.db
    .query("quoteDeliveries")
    .withIndex("by_owner_quote_revision_recipient_channel", (q) =>
      q
        .eq("ownerId", ownerId)
        .eq("quoteId", quoteId)
        .eq("revision", revision)
        .eq("recipient", recipient)
        .eq("channel", channel),
    )
    .unique();
}

async function requiredByDeliveryAttemptId(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  deliveryAttemptId: string,
): Promise<Doc<"quoteDeliveries">> {
  const doc = await ctx.db
    .query("quoteDeliveries")
    .withIndex("by_owner_and_delivery_attempt_id", (q) =>
      q.eq("ownerId", ownerId).eq("deliveryAttemptId", deliveryAttemptId),
    )
    .unique();
  if (!doc) throw new Error("Quote delivery attempt not found.");
  return doc;
}

async function replaceAttempt(
  ctx: MutationCtx,
  doc: Doc<"quoteDeliveries">,
  replacement: Omit<Doc<"quoteDeliveries">, "_id" | "_creationTime">,
): Promise<Doc<"quoteDeliveries">> {
  await ctx.db.replace("quoteDeliveries", doc._id, replacement);
  const next = await ctx.db.get("quoteDeliveries", doc._id);
  if (!next) throw new Error("Quote delivery attempt update failed.");
  return next;
}

export const getBySendScope = query({
  args: {
    serviceToken: v.string(),
    quoteId: v.string(),
    revision: v.number(),
    recipient: v.string(),
    channel: quoteDeliveryChannelValidator,
  },
  returns: v.union(quoteDeliveryDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return findBySendScope(
      ctx,
      ownerId,
      cleanRequiredText(args.quoteId, "Quote ID"),
      validatedRevision(args.revision),
      cleanRequiredText(args.recipient, "Delivery recipient"),
      args.channel,
    );
  },
});

export const createPending = mutation({
  args: {
    serviceToken: v.string(),
    quoteId: v.string(),
    revision: v.number(),
    recipient: v.string(),
    channel: quoteDeliveryChannelValidator,
    revisionId: v.string(),
    revisionFingerprint: v.string(),
    sendFingerprint: v.string(),
    idempotencyKey: v.string(),
    approvalId: v.string(),
    actionFingerprint: v.string(),
    provider: v.string(),
  },
  returns: quoteDeliveryDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const quoteId = cleanRequiredText(args.quoteId, "Quote ID");
    const revision = validatedRevision(args.revision);
    const recipient = cleanRequiredText(args.recipient, "Delivery recipient");
    const sendFingerprint = cleanRequiredText(args.sendFingerprint, "Send fingerprint");

    const existing = await findBySendScope(
      ctx,
      ownerId,
      quoteId,
      revision,
      recipient,
      args.channel,
    );
    if (existing) {
      if (existing.sendFingerprint === sendFingerprint) return existing;
      throw new QuoteDeliverySendConflictError();
    }

    const attempt = buildQuoteDeliveryAttempt({
      ownerId,
      deliveryAttemptId: globalThis.crypto.randomUUID(),
      quoteId,
      revision,
      recipient,
      channel: args.channel,
      revisionId: cleanRequiredText(args.revisionId, "Quote revision ID"),
      revisionFingerprint: cleanRequiredText(
        args.revisionFingerprint,
        "Quote revision fingerprint",
      ),
      sendFingerprint,
      idempotencyKey: cleanRequiredText(args.idempotencyKey, "Idempotency key"),
      approvalId: cleanRequiredText(args.approvalId, "Approval ID"),
      actionFingerprint: cleanRequiredText(args.actionFingerprint, "Action fingerprint"),
      provider: cleanRequiredText(args.provider, "Delivery provider"),
      now: Date.now(),
    });
    const id = await ctx.db.insert("quoteDeliveries", attempt);
    const doc = await ctx.db.get("quoteDeliveries", id);
    if (!doc) throw new Error("Quote delivery attempt creation failed.");
    return doc;
  },
});

export const markExecuting = mutation({
  args: { serviceToken: v.string(), deliveryAttemptId: v.string() },
  returns: quoteDeliveryDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const doc = await requiredByDeliveryAttemptId(
      ctx,
      ownerId,
      cleanRequiredText(args.deliveryAttemptId, "Delivery attempt ID"),
    );
    return replaceAttempt(ctx, doc, markQuoteDeliveryExecuting(doc, Date.now()));
  },
});

export const bindProviderReference = mutation({
  args: {
    serviceToken: v.string(),
    deliveryAttemptId: v.string(),
    providerRequestId: v.string(),
    providerCorrelationId: v.optional(v.string()),
    reconciliationId: v.optional(v.string()),
  },
  returns: quoteDeliveryDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const doc = await requiredByDeliveryAttemptId(
      ctx,
      ownerId,
      cleanRequiredText(args.deliveryAttemptId, "Delivery attempt ID"),
    );
    return replaceAttempt(
      ctx,
      doc,
      bindQuoteDeliveryProviderReference({
        attempt: doc,
        providerRequestId: cleanRequiredText(args.providerRequestId, "Provider request ID"),
        ...(args.providerCorrelationId === undefined
          ? {}
          : { providerCorrelationId: args.providerCorrelationId }),
        ...(args.reconciliationId === undefined ? {} : { reconciliationId: args.reconciliationId }),
        now: Date.now(),
      }),
    );
  },
});

export const complete = mutation({
  args: {
    serviceToken: v.string(),
    deliveryAttemptId: v.string(),
    outcome: quoteDeliveryOutcomeValidator,
    providerErrorCode: v.optional(v.string()),
  },
  returns: quoteDeliveryDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const doc = await requiredByDeliveryAttemptId(
      ctx,
      ownerId,
      cleanRequiredText(args.deliveryAttemptId, "Delivery attempt ID"),
    );
    return replaceAttempt(
      ctx,
      doc,
      completeQuoteDelivery({
        attempt: doc,
        outcome: args.outcome,
        ...(args.providerErrorCode === undefined
          ? {}
          : { providerErrorCode: args.providerErrorCode }),
        now: Date.now(),
      }),
    );
  },
});

export const markIndeterminate = mutation({
  args: {
    serviceToken: v.string(),
    deliveryAttemptId: v.string(),
    reconciliationId: v.string(),
    providerErrorCode: v.optional(v.string()),
  },
  returns: quoteDeliveryDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const doc = await requiredByDeliveryAttemptId(
      ctx,
      ownerId,
      cleanRequiredText(args.deliveryAttemptId, "Delivery attempt ID"),
    );
    return replaceAttempt(
      ctx,
      doc,
      markQuoteDeliveryIndeterminate({
        attempt: doc,
        reconciliationId: cleanRequiredText(args.reconciliationId, "Reconciliation ID"),
        ...(args.providerErrorCode === undefined
          ? {}
          : { providerErrorCode: args.providerErrorCode }),
        now: Date.now(),
      }),
    );
  },
});

export const reconcile = mutation({
  args: {
    serviceToken: v.string(),
    deliveryAttemptId: v.string(),
    reconciliationId: v.string(),
    outcome: quoteDeliveryOutcomeValidator,
    providerErrorCode: v.optional(v.string()),
  },
  returns: quoteDeliveryDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const doc = await requiredByDeliveryAttemptId(
      ctx,
      ownerId,
      cleanRequiredText(args.deliveryAttemptId, "Delivery attempt ID"),
    );
    return replaceAttempt(
      ctx,
      doc,
      reconcileQuoteDelivery({
        attempt: doc,
        reconciliationId: cleanRequiredText(args.reconciliationId, "Reconciliation ID"),
        outcome: args.outcome,
        ...(args.providerErrorCode === undefined
          ? {}
          : { providerErrorCode: args.providerErrorCode }),
        now: Date.now(),
      }),
    );
  },
});
