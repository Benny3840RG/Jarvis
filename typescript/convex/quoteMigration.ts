/**
 * Development-only legacy quote migration.
 *
 * These mutations import rows from the flat legacy QuoteStore
 * (src/quotes/quote.ts) into the new revision-based quote model. They are
 * intentionally NOT exported through HTTP, MCP, tool actions, or production
 * runtime wiring. The CLI entry point (src/tools/migrateLegacyQuotes.ts)
 * guards the development-deployment requirement before calling these functions.
 *
 * Mapping contract:
 *   draft    → revision draft,               aggregate open
 *   sent     → revision finalized,           aggregate open  (migration-imported)
 *   accepted → revision finalized + outcome, aggregate accepted
 *   declined → revision finalized + outcome, aggregate declined
 */

import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  buildInitialQuoteRecords,
  convexQuoteRevisionFingerprint,
  quoteLineItemValidator,
} from "./quoteValidators.js";
import { mutation } from "./_generated/server.js";

export type LegacyQuoteStatus = "draft" | "sent" | "accepted" | "declined";

/** Shape of a single row from the legacy flat QuoteStore. */
export type LegacyQuoteRow = {
  id: string;
  clientId: string;
  projectId?: string;
  number: string;
  status: LegacyQuoteStatus;
  lineItems: Array<{ description: string; quantity: number; unitPrice: number }>;
  taxRate?: number;
  validUntil?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

export type MigrationRowResult = {
  legacyId: string;
  quoteId: string;
  revisionId: string;
  mappedStatus: "draft" | "finalized";
  skipped: boolean;
  rejectionReason?: string;
};

/**
 * Imports a single legacy quote row into the new revision-based model.
 *
 * Idempotent: if a quote with the same `quoteId` (derived from the legacy `id`)
 * already exists, the row is skipped and the existing IDs are returned.
 * The legacy `id` is used as the `quoteId` to ensure a stable, reversible mapping.
 */
export const importLegacyQuote = mutation({
  args: {
    serviceToken: v.string(),
    legacyId: v.string(),
    legacyRevisionId: v.string(),
    clientId: v.string(),
    projectId: v.optional(v.string()),
    number: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("sent"),
      v.literal("accepted"),
      v.literal("declined"),
    ),
    lineItems: v.array(quoteLineItemValidator),
    taxRate: v.optional(v.number()),
    validUntil: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  returns: v.object({
    legacyId: v.string(),
    quoteId: v.string(),
    revisionId: v.string(),
    mappedStatus: v.union(v.literal("draft"), v.literal("finalized")),
    skipped: v.boolean(),
    rejectionReason: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<MigrationRowResult> => {
    const ownerId = requireOwner(args.serviceToken);
    const quoteId = args.legacyId;
    const revisionId = args.legacyRevisionId;

    // Idempotency: skip if already imported (quoteId == legacy id).
    const existing = await ctx.db
      .query("quotes")
      .withIndex("by_owner_and_quote_id", (q) => q.eq("ownerId", ownerId).eq("quoteId", quoteId))
      .unique();
    if (existing) {
      const existingRevision = await ctx.db
        .query("quoteRevisions")
        .withIndex("by_owner_quote_and_revision", (q) =>
          q.eq("ownerId", ownerId).eq("quoteId", quoteId).eq("revision", 1),
        )
        .unique();
      return {
        legacyId: args.legacyId,
        quoteId,
        revisionId: existingRevision?.revisionId ?? revisionId,
        mappedStatus: args.status === "draft" ? "draft" : "finalized",
        skipped: true,
      };
    }

    const now = Date.now();
    const records = buildInitialQuoteRecords({
      ownerId,
      quoteId,
      revisionId,
      clientId: args.clientId,
      ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
      number: args.number,
      lineItems: args.lineItems,
      ...(args.taxRate === undefined ? {} : { taxRate: args.taxRate }),
      ...(args.validUntil === undefined ? {} : { validUntil: args.validUntil }),
      ...(args.notes === undefined ? {} : { notes: args.notes }),
      termsIncluded: false,
      now,
    });
    // Preserve original timestamps from legacy data.
    records.aggregate.createdAt = args.createdAt;
    records.aggregate.updatedAt = args.updatedAt;
    records.revision.createdAt = args.createdAt;
    records.revision.updatedAt = args.updatedAt;

    if (args.status === "draft") {
      await ctx.db.insert("quotes", records.aggregate);
      await ctx.db.insert("quoteRevisions", records.revision);
      return {
        legacyId: args.legacyId,
        quoteId,
        revisionId,
        mappedStatus: "draft",
        skipped: false,
      };
    }

    // For sent / accepted / declined: create a migration-imported finalized revision.
    // Transition: draft -> reviewed (inline) -> finalized. We bypass the
    // controlled guards here because the legacy record is already in a terminal
    // state and no further review step is appropriate.
    const reviewedRevision = {
      ...records.revision,
      status: "reviewed" as const,
      reviewedAt: args.updatedAt,
      updatedAt: args.updatedAt,
    };
    const fingerprint = await convexQuoteRevisionFingerprint(records.aggregate, reviewedRevision);
    const finalizedRevision = {
      ...reviewedRevision,
      status: "finalized" as const,
      fingerprint,
      finalizedAt: args.updatedAt,
      revisionVersion: 2,
      updatedAt: args.updatedAt,
    };

    // Map aggregate commercial status.
    const commercialStatus =
      args.status === "accepted"
        ? ("accepted" as const)
        : args.status === "declined"
          ? ("declined" as const)
          : ("open" as const);

    const finalizedAggregate = {
      ...records.aggregate,
      aggregateVersion: 2,
      commercialStatus,
      ...(commercialStatus !== "open"
        ? {
            commercialRevision: 1,
            commercialRecordedAt: args.updatedAt,
          }
        : {}),
      updatedAt: args.updatedAt,
    };
    const finalizedRevisionWithOutcome =
      commercialStatus !== "open"
        ? {
            ...finalizedRevision,
            historicalOutcome: commercialStatus,
            historicalOutcomeRecordedAt: args.updatedAt,
          }
        : finalizedRevision;

    await ctx.db.insert("quotes", finalizedAggregate);
    await ctx.db.insert("quoteRevisions", finalizedRevisionWithOutcome);
    return {
      legacyId: args.legacyId,
      quoteId,
      revisionId,
      mappedStatus: "finalized",
      skipped: false,
    };
  },
});

/**
 * Development-only cleanup: removes the migrated aggregate and all its
 * revisions for a given `quoteId`. Used by the migration smoke and tests.
 */
export const cleanupImportedQuote = mutation({
  args: { serviceToken: v.string(), quoteId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const ownerId = requireOwner(args.serviceToken);
    const aggregate = await ctx.db
      .query("quotes")
      .withIndex("by_owner_and_quote_id", (q) =>
        q.eq("ownerId", ownerId).eq("quoteId", args.quoteId),
      )
      .unique();
    if (aggregate) await ctx.db.delete("quotes", aggregate._id);

    const revisions = await ctx.db
      .query("quoteRevisions")
      .withIndex("by_owner_quote_and_revision", (q) =>
        q.eq("ownerId", ownerId).eq("quoteId", args.quoteId),
      )
      .collect();
    for (const rev of revisions) await ctx.db.delete("quoteRevisions", rev._id);

    return null;
  },
});

/**
 * Development-only cleanup: removes all delivery attempts for a quote (optionally
 * filtered to a specific revision number). Used by the quote lifecycle smoke test
 * to ensure synthetic records do not accumulate in the development deployment.
 */
export const cleanupQuoteDeliveries = mutation({
  args: {
    serviceToken: v.string(),
    quoteId: v.string(),
    revision: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const ownerId = requireOwner(args.serviceToken);
    const { quoteId, revision } = args;

    const attempts =
      revision !== undefined
        ? await ctx.db
            .query("quoteDeliveryAttempts")
            .withIndex("by_owner_quote_and_revision", (q) =>
              q.eq("ownerId", ownerId).eq("quoteId", quoteId).eq("revision", revision),
            )
            .collect()
        : await ctx.db
            .query("quoteDeliveryAttempts")
            .withIndex("by_owner_quote_and_revision", (q) =>
              q.eq("ownerId", ownerId).eq("quoteId", quoteId),
            )
            .collect();

    for (const attempt of attempts) await ctx.db.delete("quoteDeliveryAttempts", attempt._id);
    return null;
  },
});
