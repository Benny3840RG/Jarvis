import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  applyQuoteDraftPatch,
  buildInitialQuoteRecords,
  finalizeQuoteRevision,
  forkFinalizedQuote,
  quoteHistoricalOutcomeValidator,
  quoteLineItemValidator,
  quoteSnapshotDocumentValidator,
  recordQuoteCommercialOutcome,
  transitionQuoteRevision,
} from "./quoteValidators.js";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";

const MAX_LIST_LIMIT = 100;

const revisionCommandArgs = {
  serviceToken: v.string(),
  quoteId: v.string(),
  revision: v.number(),
  expectedAggregateVersion: v.number(),
  expectedRevisionVersion: v.number(),
};

const draftPatchValidator = v.object({
  lineItems: v.optional(v.array(quoteLineItemValidator)),
  taxRate: v.optional(v.union(v.number(), v.null())),
  validUntil: v.optional(v.union(v.string(), v.null())),
  notes: v.optional(v.union(v.string(), v.null())),
  termsIncluded: v.optional(v.boolean()),
});

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

function validatedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`Quote list limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return limit;
}

async function findAggregate(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  quoteId: string,
): Promise<Doc<"quotes"> | null> {
  return ctx.db
    .query("quotes")
    .withIndex("by_owner_and_quote_id", (q) => q.eq("ownerId", ownerId).eq("quoteId", quoteId))
    .unique();
}

async function findRevision(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  quoteId: string,
  revision: number,
): Promise<Doc<"quoteRevisions"> | null> {
  return ctx.db
    .query("quoteRevisions")
    .withIndex("by_owner_quote_and_revision", (q) =>
      q.eq("ownerId", ownerId).eq("quoteId", quoteId).eq("revision", revision),
    )
    .unique();
}

async function currentSnapshot(ctx: QueryCtx | MutationCtx, ownerId: string, quoteId: string) {
  const aggregate = await findAggregate(ctx, ownerId, quoteId);
  if (!aggregate) return null;
  const revision = await findRevision(ctx, ownerId, quoteId, aggregate.currentRevision);
  if (!revision || revision.revisionId !== aggregate.currentRevisionId) {
    throw new Error("Quote aggregate points to a missing revision.");
  }
  return { aggregate, revision };
}

async function requiredSnapshot(
  ctx: MutationCtx,
  ownerId: string,
  quoteId: string,
  revision: number,
) {
  const aggregate = await findAggregate(ctx, ownerId, quoteId);
  const quoteRevision = await findRevision(ctx, ownerId, quoteId, revision);
  if (!aggregate || !quoteRevision) throw new Error("Quote not found.");
  return { aggregate, revision: quoteRevision };
}

async function replaceSnapshot(
  ctx: MutationCtx,
  current: { aggregate: Doc<"quotes">; revision: Doc<"quoteRevisions"> },
  replacement: {
    aggregate: Omit<Doc<"quotes">, "_id" | "_creationTime">;
    revision: Omit<Doc<"quoteRevisions">, "_id" | "_creationTime">;
  },
) {
  await ctx.db.replace("quotes", current.aggregate._id, replacement.aggregate);
  await ctx.db.replace("quoteRevisions", current.revision._id, replacement.revision);
  const aggregate = await ctx.db.get("quotes", current.aggregate._id);
  const revision = await ctx.db.get("quoteRevisions", current.revision._id);
  if (!aggregate || !revision) throw new Error("Quote lifecycle update failed.");
  return { aggregate, revision };
}

export const create = mutation({
  args: {
    serviceToken: v.string(),
    clientId: v.string(),
    projectId: v.optional(v.string()),
    number: v.string(),
    lineItems: v.array(quoteLineItemValidator),
    taxRate: v.optional(v.number()),
    validUntil: v.optional(v.string()),
    notes: v.optional(v.string()),
    termsIncluded: v.boolean(),
  },
  returns: quoteSnapshotDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const number = cleanRequiredText(args.number, "Quote number");
    const existing = await ctx.db
      .query("quotes")
      .withIndex("by_owner_and_number", (q) => q.eq("ownerId", ownerId).eq("number", number))
      .unique();
    if (existing) throw new Error("Quote number already exists for this owner.");

    const records = buildInitialQuoteRecords({
      ownerId,
      quoteId: globalThis.crypto.randomUUID(),
      revisionId: globalThis.crypto.randomUUID(),
      clientId: args.clientId,
      ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
      number,
      lineItems: args.lineItems,
      ...(args.taxRate === undefined ? {} : { taxRate: args.taxRate }),
      ...(args.validUntil === undefined ? {} : { validUntil: args.validUntil }),
      ...(args.notes === undefined ? {} : { notes: args.notes }),
      termsIncluded: args.termsIncluded,
      now: Date.now(),
    });
    const aggregateId = await ctx.db.insert("quotes", records.aggregate);
    const revisionId = await ctx.db.insert("quoteRevisions", records.revision);
    const aggregate = await ctx.db.get("quotes", aggregateId);
    const revision = await ctx.db.get("quoteRevisions", revisionId);
    if (!aggregate || !revision) throw new Error("Quote creation failed.");
    return { aggregate, revision };
  },
});

export const get = query({
  args: { serviceToken: v.string(), quoteId: v.string() },
  returns: v.union(quoteSnapshotDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return currentSnapshot(ctx, ownerId, cleanRequiredText(args.quoteId, "Quote ID"));
  },
});

export const list = query({
  args: {
    serviceToken: v.string(),
    clientId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    commercialStatus: v.optional(
      v.union(
        v.literal("open"),
        v.literal("accepted"),
        v.literal("declined"),
        v.literal("expired"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  returns: v.array(quoteSnapshotDocumentValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const limit = validatedLimit(args.limit);
    let aggregates: Doc<"quotes">[];
    if (args.clientId !== undefined) {
      aggregates = await ctx.db
        .query("quotes")
        .withIndex("by_owner_and_client_id", (q) =>
          q.eq("ownerId", ownerId).eq("clientId", cleanRequiredText(args.clientId!, "Client ID")),
        )
        .order("desc")
        .take(limit);
    } else if (args.projectId !== undefined) {
      aggregates = await ctx.db
        .query("quotes")
        .withIndex("by_owner_and_project_id", (q) =>
          q
            .eq("ownerId", ownerId)
            .eq("projectId", cleanRequiredText(args.projectId!, "Project ID")),
        )
        .order("desc")
        .take(limit);
    } else if (args.commercialStatus !== undefined) {
      aggregates = await ctx.db
        .query("quotes")
        .withIndex("by_owner_and_commercial_status", (q) =>
          q.eq("ownerId", ownerId).eq("commercialStatus", args.commercialStatus!),
        )
        .order("desc")
        .take(limit);
    } else {
      aggregates = await ctx.db
        .query("quotes")
        .withIndex("by_owner_and_number", (q) => q.eq("ownerId", ownerId))
        .order("desc")
        .take(limit);
    }

    const snapshots = [];
    for (const aggregate of aggregates) {
      const revision = await findRevision(
        ctx,
        ownerId,
        aggregate.quoteId,
        aggregate.currentRevision,
      );
      if (!revision || revision.revisionId !== aggregate.currentRevisionId) {
        throw new Error("Quote aggregate points to a missing revision.");
      }
      snapshots.push({ aggregate, revision });
    }
    return snapshots;
  },
});

export const updateDraft = mutation({
  args: {
    ...revisionCommandArgs,
    patch: draftPatchValidator,
  },
  returns: quoteSnapshotDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const quoteId = cleanRequiredText(args.quoteId, "Quote ID");
    const revisionNumber = validatedRevision(args.revision);
    const current = await requiredSnapshot(ctx, ownerId, quoteId, revisionNumber);
    const replacement = applyQuoteDraftPatch({
      aggregate: current.aggregate,
      revision: current.revision,
      expectedAggregateVersion: args.expectedAggregateVersion,
      expectedRevisionVersion: args.expectedRevisionVersion,
      patch: args.patch,
      now: Date.now(),
    });
    return replaceSnapshot(ctx, current, replacement);
  },
});

export const submitForReview = mutation({
  args: revisionCommandArgs,
  returns: quoteSnapshotDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const current = await requiredSnapshot(
      ctx,
      ownerId,
      cleanRequiredText(args.quoteId, "Quote ID"),
      validatedRevision(args.revision),
    );
    return replaceSnapshot(
      ctx,
      current,
      transitionQuoteRevision({
        aggregate: current.aggregate,
        revision: current.revision,
        expectedAggregateVersion: args.expectedAggregateVersion,
        expectedRevisionVersion: args.expectedRevisionVersion,
        to: "reviewed",
        now: Date.now(),
      }),
    );
  },
});

export const reopenForEditing = mutation({
  args: revisionCommandArgs,
  returns: quoteSnapshotDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const current = await requiredSnapshot(
      ctx,
      ownerId,
      cleanRequiredText(args.quoteId, "Quote ID"),
      validatedRevision(args.revision),
    );
    return replaceSnapshot(
      ctx,
      current,
      transitionQuoteRevision({
        aggregate: current.aggregate,
        revision: current.revision,
        expectedAggregateVersion: args.expectedAggregateVersion,
        expectedRevisionVersion: args.expectedRevisionVersion,
        to: "draft",
        now: Date.now(),
      }),
    );
  },
});

export const finalizeRevision = mutation({
  args: revisionCommandArgs,
  returns: quoteSnapshotDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const current = await requiredSnapshot(
      ctx,
      ownerId,
      cleanRequiredText(args.quoteId, "Quote ID"),
      validatedRevision(args.revision),
    );
    return replaceSnapshot(
      ctx,
      current,
      await finalizeQuoteRevision({
        aggregate: current.aggregate,
        revision: current.revision,
        expectedAggregateVersion: args.expectedAggregateVersion,
        expectedRevisionVersion: args.expectedRevisionVersion,
        now: Date.now(),
      }),
    );
  },
});

export const forkRevision = mutation({
  args: {
    ...revisionCommandArgs,
    expectedFingerprint: v.string(),
  },
  returns: quoteSnapshotDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const current = await requiredSnapshot(
      ctx,
      ownerId,
      cleanRequiredText(args.quoteId, "Quote ID"),
      validatedRevision(args.revision),
    );
    const replacement = forkFinalizedQuote({
      aggregate: current.aggregate,
      revision: current.revision,
      expectedAggregateVersion: args.expectedAggregateVersion,
      expectedRevisionVersion: args.expectedRevisionVersion,
      expectedFingerprint: cleanRequiredText(args.expectedFingerprint, "Quote fingerprint"),
      newRevisionId: globalThis.crypto.randomUUID(),
      now: Date.now(),
    });
    const revisionId = await ctx.db.insert("quoteRevisions", replacement.revision);
    await ctx.db.replace("quotes", current.aggregate._id, replacement.aggregate);
    const aggregate = await ctx.db.get("quotes", current.aggregate._id);
    const revision = await ctx.db.get("quoteRevisions", revisionId);
    if (!aggregate || !revision) throw new Error("Quote revision fork failed.");
    return { aggregate, revision };
  },
});

export const recordCommercialOutcome = mutation({
  args: {
    serviceToken: v.string(),
    quoteId: v.string(),
    revision: v.number(),
    expectedAggregateVersion: v.number(),
    outcome: quoteHistoricalOutcomeValidator,
  },
  returns: quoteSnapshotDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const current = await requiredSnapshot(
      ctx,
      ownerId,
      cleanRequiredText(args.quoteId, "Quote ID"),
      validatedRevision(args.revision),
    );
    return replaceSnapshot(
      ctx,
      current,
      recordQuoteCommercialOutcome({
        aggregate: current.aggregate,
        revision: current.revision,
        expectedAggregateVersion: args.expectedAggregateVersion,
        outcome: args.outcome,
        now: Date.now(),
      }),
    );
  },
});
