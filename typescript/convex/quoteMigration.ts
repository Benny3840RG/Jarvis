import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { convexQuoteRevisionFingerprint, quoteLineItemValidator } from "./quoteValidators.js";
import {
  computeQuoteTotals,
  type QuoteAggregate,
  type QuoteRevision,
  type QuoteRevisionLineItem,
} from "../src/quotes/quoteLifecycle.js";
import { mutation } from "./_generated/server.js";

/**
 * The single authorised development deployment for destructive/one-off
 * dev-only operations, matching the existing repo-wide convention (see
 * `externalReconciliations.cleanup`). Never used to gate anything reachable
 * from production runtime wiring.
 */
const AUTHORISED_DEV_DEPLOYMENT = "dev:outgoing-ram-798";

const legacyQuoteStatusValidator = v.union(
  v.literal("draft"),
  v.literal("sent"),
  v.literal("accepted"),
  v.literal("declined"),
);

const migrationResultValidator = v.object({
  sourceKey: v.string(),
  status: v.union(v.literal("imported"), v.literal("rejected")),
  quoteId: v.optional(v.string()),
  revisionId: v.optional(v.string()),
  mappedState: v.optional(v.string()),
  rejectionReason: v.optional(v.string()),
});

export type QuoteMigrationResult = {
  sourceKey: string;
  status: "imported" | "rejected";
  quoteId?: string;
  revisionId?: string;
  mappedState?: string;
  rejectionReason?: string;
};

function cleanRequiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new TypeError(`${field} cannot be empty.`);
  return cleaned;
}

function cleanOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
}

function normalizeLineItems(lineItems: readonly QuoteRevisionLineItem[]): QuoteRevisionLineItem[] {
  return lineItems.map((item) => ({
    description: item.description.trim(),
    quantity: item.quantity,
    unitPrice: item.unitPrice,
  }));
}

export const importLegacyQuote = mutation({
  args: {
    serviceToken: v.string(),
    deployment: v.string(),
    sourceKey: v.string(),
    clientId: v.string(),
    projectId: v.optional(v.string()),
    number: v.string(),
    status: legacyQuoteStatusValidator,
    lineItems: v.array(quoteLineItemValidator),
    taxRate: v.optional(v.number()),
    validUntil: v.optional(v.string()),
    notes: v.optional(v.string()),
    termsIncluded: v.boolean(),
    legacyCreatedAt: v.number(),
    legacyUpdatedAt: v.number(),
  },
  returns: migrationResultValidator,
  handler: async (ctx, args): Promise<QuoteMigrationResult> => {
    const ownerId = requireOwner(args.serviceToken);
    if (args.deployment !== AUTHORISED_DEV_DEPLOYMENT) {
      throw new Error(
        "Legacy quote migration is restricted to the authorised development deployment.",
      );
    }
    const sourceKey = cleanRequiredText(args.sourceKey, "Legacy source key");

    const existing = await ctx.db
      .query("quoteMigrationRecords")
      .withIndex("by_owner_and_source_key", (q) =>
        q.eq("ownerId", ownerId).eq("sourceKey", sourceKey),
      )
      .unique();
    if (existing) {
      return {
        sourceKey,
        status: existing.status,
        ...(existing.quoteId === undefined ? {} : { quoteId: existing.quoteId }),
        ...(existing.revisionId === undefined ? {} : { revisionId: existing.revisionId }),
        ...(existing.mappedState === undefined ? {} : { mappedState: existing.mappedState }),
        ...(existing.rejectionReason === undefined
          ? {}
          : { rejectionReason: existing.rejectionReason }),
      };
    }

    async function reject(reason: string) {
      await ctx.db.insert("quoteMigrationRecords", {
        ownerId,
        sourceKey,
        status: "rejected",
        rejectionReason: reason,
        createdAt: Date.now(),
      });
      return { sourceKey, status: "rejected" as const, rejectionReason: reason };
    }

    if (args.lineItems.length === 0) {
      return reject("Legacy quote has no line items.");
    }
    const number = cleanRequiredText(args.number, "Quote number");
    const numberTaken = await ctx.db
      .query("quotes")
      .withIndex("by_owner_and_number", (q) => q.eq("ownerId", ownerId).eq("number", number))
      .unique();
    if (numberTaken) {
      return reject(`Quote number "${number}" already exists for this owner.`);
    }

    const lineItems = normalizeLineItems(args.lineItems);
    const totals = computeQuoteTotals(lineItems, args.taxRate);
    const clientId = cleanRequiredText(args.clientId, "Quote client ID");
    const projectId = cleanOptionalText(args.projectId);
    const validUntil = cleanOptionalText(args.validUntil);
    const notes = cleanOptionalText(args.notes);
    const quoteId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();

    const aggregate: QuoteAggregate = {
      ownerId,
      quoteId,
      clientId,
      ...(projectId === undefined ? {} : { projectId }),
      number,
      currentRevision: 1,
      currentRevisionId: revisionId,
      aggregateVersion: 1,
      commercialStatus: "open",
      createdAt: args.legacyCreatedAt,
      updatedAt: args.legacyUpdatedAt,
    };
    const revision: QuoteRevision = {
      ownerId,
      quoteId,
      revisionId,
      revision: 1,
      revisionVersion: 1,
      status: "draft",
      lineItems,
      subtotal: totals.subtotal,
      ...(args.taxRate === undefined ? {} : { taxRate: args.taxRate }),
      tax: totals.tax,
      total: totals.total,
      currency: "AUD",
      ...(validUntil === undefined ? {} : { validUntil }),
      ...(notes === undefined ? {} : { notes }),
      termsIncluded: args.termsIncluded,
      createdAt: args.legacyCreatedAt,
      updatedAt: args.legacyUpdatedAt,
    };

    let mappedState: string;
    if (args.status === "draft") {
      mappedState = "draft";
    } else {
      revision.status = "finalized";
      revision.finalizedAt = args.legacyUpdatedAt;
      revision.source = "legacy-migration";
      revision.fingerprint = await convexQuoteRevisionFingerprint(aggregate, revision);
      if (args.status === "sent") {
        mappedState = "finalized:open";
      } else {
        aggregate.commercialStatus = args.status;
        aggregate.commercialRevision = 1;
        aggregate.commercialRecordedAt = args.legacyUpdatedAt;
        revision.historicalOutcome = args.status;
        revision.historicalOutcomeRecordedAt = args.legacyUpdatedAt;
        mappedState = `finalized:${args.status}`;
      }
    }

    await ctx.db.insert("quotes", aggregate);
    await ctx.db.insert("quoteRevisions", revision);
    await ctx.db.insert("quoteMigrationRecords", {
      ownerId,
      sourceKey,
      status: "imported",
      quoteId,
      revisionId,
      mappedState,
      createdAt: Date.now(),
    });

    return { sourceKey, status: "imported" as const, quoteId, revisionId, mappedState };
  },
});
