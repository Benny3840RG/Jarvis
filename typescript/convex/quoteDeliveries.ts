import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  quoteDeliveryAttemptDocumentValidator,
  quoteDeliveryChannelValidator,
  quoteDeliveryReconciledOutcomeValidator,
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
    throw new Error("Quote delivery revision must be a positive integer.");
  }
  return value;
}

const sendScopeArgs = {
  quoteId: v.string(),
  revision: v.number(),
  recipient: v.string(),
  channel: quoteDeliveryChannelValidator,
};

async function findBySendScope(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  quoteId: string,
  revision: number,
  recipient: string,
  channel: "email",
): Promise<Doc<"quoteDeliveryAttempts"> | null> {
  return ctx.db
    .query("quoteDeliveryAttempts")
    .withIndex("by_owner_and_send_scope", (q) =>
      q
        .eq("ownerId", ownerId)
        .eq("quoteId", quoteId)
        .eq("revision", revision)
        .eq("recipient", recipient)
        .eq("channel", channel),
    )
    .unique();
}

async function requiredDeliveryAttempt(
  ctx: MutationCtx,
  ownerId: string,
  deliveryAttemptId: string,
): Promise<Doc<"quoteDeliveryAttempts">> {
  const attempt = await ctx.db
    .query("quoteDeliveryAttempts")
    .withIndex("by_owner_and_delivery_attempt_id", (q) =>
      q.eq("ownerId", ownerId).eq("deliveryAttemptId", deliveryAttemptId),
    )
    .unique();
  if (!attempt) throw new Error("Quote delivery attempt not found.");
  return attempt;
}

function requireExpectedStatus(
  attempt: Doc<"quoteDeliveryAttempts">,
  expectedStatus: Doc<"quoteDeliveryAttempts">["status"],
): void {
  if (attempt.status !== expectedStatus) {
    throw new Error(
      `Quote delivery attempt ${attempt.deliveryAttemptId} is ${attempt.status}, expected ${expectedStatus}.`,
    );
  }
}

export const createPending = mutation({
  args: {
    serviceToken: v.string(),
    ...sendScopeArgs,
    revisionId: v.string(),
    revisionFingerprint: v.string(),
    sendFingerprint: v.string(),
    idempotencyKey: v.string(),
    approvalId: v.string(),
    actionFingerprint: v.string(),
    provider: v.string(),
  },
  returns: quoteDeliveryAttemptDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const quoteId = cleanRequiredText(args.quoteId, "Quote ID");
    const revision = validatedRevision(args.revision);
    const recipient = cleanRequiredText(args.recipient, "Recipient");

    const existing = await findBySendScope(
      ctx,
      ownerId,
      quoteId,
      revision,
      recipient,
      args.channel,
    );
    if (existing) {
      if (existing.sendFingerprint !== args.sendFingerprint) {
        throw new Error(
          `Quote ${quoteId} revision ${revision} already has a delivery attempt to ${recipient} with a different send fingerprint.`,
        );
      }
      return existing;
    }

    const now = Date.now();
    const id = await ctx.db.insert("quoteDeliveryAttempts", {
      ownerId,
      deliveryAttemptId: globalThis.crypto.randomUUID(),
      quoteId,
      revision,
      revisionId: cleanRequiredText(args.revisionId, "Revision ID"),
      revisionFingerprint: cleanRequiredText(args.revisionFingerprint, "Revision fingerprint"),
      recipient,
      channel: args.channel,
      sendFingerprint: cleanRequiredText(args.sendFingerprint, "Send fingerprint"),
      idempotencyKey: cleanRequiredText(args.idempotencyKey, "Idempotency key"),
      approvalId: cleanRequiredText(args.approvalId, "Approval ID"),
      actionFingerprint: cleanRequiredText(args.actionFingerprint, "Action fingerprint"),
      status: "pending",
      provider: cleanRequiredText(args.provider, "Provider"),
      createdAt: now,
      updatedAt: now,
    });
    const attempt = await ctx.db.get("quoteDeliveryAttempts", id);
    if (!attempt) throw new Error("Quote delivery attempt creation failed.");
    return attempt;
  },
});

export const getBySendScope = query({
  args: { serviceToken: v.string(), ...sendScopeArgs },
  returns: v.union(quoteDeliveryAttemptDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return findBySendScope(
      ctx,
      ownerId,
      cleanRequiredText(args.quoteId, "Quote ID"),
      validatedRevision(args.revision),
      cleanRequiredText(args.recipient, "Recipient"),
      args.channel,
    );
  },
});

export const markExecuting = mutation({
  args: {
    serviceToken: v.string(),
    deliveryAttemptId: v.string(),
    expectedStatus: v.literal("pending"),
  },
  returns: quoteDeliveryAttemptDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const attempt = await requiredDeliveryAttempt(ctx, ownerId, args.deliveryAttemptId);
    requireExpectedStatus(attempt, args.expectedStatus);
    const now = Date.now();
    await ctx.db.patch("quoteDeliveryAttempts", attempt._id, {
      status: "executing",
      executionStartedAt: now,
      updatedAt: now,
    });
    const updated = await ctx.db.get("quoteDeliveryAttempts", attempt._id);
    if (!updated) throw new Error("Quote delivery attempt update failed.");
    return updated;
  },
});

export const bindProviderReference = mutation({
  args: {
    serviceToken: v.string(),
    deliveryAttemptId: v.string(),
    expectedStatus: v.literal("executing"),
    providerRequestId: v.string(),
    providerCorrelationId: v.optional(v.string()),
    reconciliationId: v.optional(v.string()),
  },
  returns: quoteDeliveryAttemptDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const attempt = await requiredDeliveryAttempt(ctx, ownerId, args.deliveryAttemptId);
    requireExpectedStatus(attempt, args.expectedStatus);
    await ctx.db.patch("quoteDeliveryAttempts", attempt._id, {
      providerRequestId: cleanRequiredText(args.providerRequestId, "Provider request ID"),
      ...(args.providerCorrelationId === undefined
        ? {}
        : { providerCorrelationId: args.providerCorrelationId }),
      ...(args.reconciliationId === undefined ? {} : { reconciliationId: args.reconciliationId }),
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get("quoteDeliveryAttempts", attempt._id);
    if (!updated) throw new Error("Quote delivery attempt update failed.");
    return updated;
  },
});

export const complete = mutation({
  args: {
    serviceToken: v.string(),
    deliveryAttemptId: v.string(),
    expectedStatus: v.literal("executing"),
    outcome: quoteDeliveryReconciledOutcomeValidator,
    providerErrorCode: v.optional(v.string()),
  },
  returns: quoteDeliveryAttemptDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const attempt = await requiredDeliveryAttempt(ctx, ownerId, args.deliveryAttemptId);
    requireExpectedStatus(attempt, args.expectedStatus);
    const now = Date.now();
    await ctx.db.patch("quoteDeliveryAttempts", attempt._id, {
      status: args.outcome,
      ...(args.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: args.providerErrorCode }),
      completedAt: now,
      updatedAt: now,
    });
    const updated = await ctx.db.get("quoteDeliveryAttempts", attempt._id);
    if (!updated) throw new Error("Quote delivery attempt update failed.");
    return updated;
  },
});

export const markIndeterminate = mutation({
  args: {
    serviceToken: v.string(),
    deliveryAttemptId: v.string(),
    expectedStatus: v.literal("executing"),
    reconciliationId: v.string(),
    providerErrorCode: v.optional(v.string()),
  },
  returns: quoteDeliveryAttemptDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const attempt = await requiredDeliveryAttempt(ctx, ownerId, args.deliveryAttemptId);
    requireExpectedStatus(attempt, args.expectedStatus);
    await ctx.db.patch("quoteDeliveryAttempts", attempt._id, {
      status: "indeterminate",
      reconciliationId: cleanRequiredText(args.reconciliationId, "Reconciliation ID"),
      ...(args.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: args.providerErrorCode }),
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get("quoteDeliveryAttempts", attempt._id);
    if (!updated) throw new Error("Quote delivery attempt update failed.");
    return updated;
  },
});

export const reconcile = mutation({
  args: {
    serviceToken: v.string(),
    deliveryAttemptId: v.string(),
    expectedStatus: v.literal("indeterminate"),
    reconciliationId: v.string(),
    outcome: quoteDeliveryReconciledOutcomeValidator,
    providerErrorCode: v.optional(v.string()),
  },
  returns: quoteDeliveryAttemptDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const attempt = await requiredDeliveryAttempt(ctx, ownerId, args.deliveryAttemptId);
    requireExpectedStatus(attempt, args.expectedStatus);
    if (attempt.reconciliationId !== args.reconciliationId) {
      throw new Error(
        `Quote delivery attempt ${attempt.deliveryAttemptId} is bound to a different reconciliation record.`,
      );
    }
    const now = Date.now();
    await ctx.db.patch("quoteDeliveryAttempts", attempt._id, {
      status: "reconciled",
      reconciledOutcome: args.outcome,
      ...(args.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: args.providerErrorCode }),
      reconciledAt: now,
      updatedAt: now,
    });
    const updated = await ctx.db.get("quoteDeliveryAttempts", attempt._id);
    if (!updated) throw new Error("Quote delivery attempt update failed.");
    return updated;
  },
});

export const listForQuote = query({
  args: {
    serviceToken: v.string(),
    quoteId: v.string(),
    revision: v.optional(v.number()),
  },
  returns: v.array(quoteDeliveryAttemptDocumentValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const quoteId = cleanRequiredText(args.quoteId, "Quote ID");
    if (args.revision !== undefined) {
      const revision = validatedRevision(args.revision);
      return ctx.db
        .query("quoteDeliveryAttempts")
        .withIndex("by_owner_quote_and_revision", (q) =>
          q.eq("ownerId", ownerId).eq("quoteId", quoteId).eq("revision", revision),
        )
        .order("desc")
        .take(200);
    }
    return ctx.db
      .query("quoteDeliveryAttempts")
      .withIndex("by_owner_quote_and_revision", (q) =>
        q.eq("ownerId", ownerId).eq("quoteId", quoteId),
      )
      .order("desc")
      .take(200);
  },
});
