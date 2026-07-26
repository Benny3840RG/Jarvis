import type { Quote, QuoteStore } from "../quotes/quote.js";

export type LegacyQuoteImportInput = {
  serviceToken: string;
  deployment: string;
  sourceKey: string;
  clientId: string;
  projectId?: string;
  number: string;
  status: "draft" | "sent" | "accepted" | "declined";
  lineItems: { description: string; quantity: number; unitPrice: number }[];
  taxRate?: number;
  validUntil?: string;
  notes?: string;
  termsIncluded: boolean;
  legacyCreatedAt: number;
  legacyUpdatedAt: number;
};

export type LegacyQuoteImportResult = {
  sourceKey: string;
  status: "imported" | "rejected";
  quoteId?: string;
  revisionId?: string;
  mappedState?: string;
  rejectionReason?: string;
};

export type ImportLegacyQuoteFn = (
  input: LegacyQuoteImportInput,
) => Promise<LegacyQuoteImportResult>;

export type LegacyQuoteMigrationSummary = {
  total: number;
  imported: number;
  rejected: number;
  results: LegacyQuoteImportResult[];
};

/** Stable across replays: derived from the legacy record's own ID, never regenerated. */
export function legacySourceKey(quote: Quote): string {
  return `legacy-quote:${quote.id}`;
}

export function mapLegacyQuote(
  quote: Quote,
  serviceToken: string,
  deployment: string,
): LegacyQuoteImportInput {
  return {
    serviceToken,
    deployment,
    sourceKey: legacySourceKey(quote),
    clientId: quote.clientId,
    ...(quote.projectId === undefined ? {} : { projectId: quote.projectId }),
    number: quote.number,
    status: quote.status,
    lineItems: quote.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
    ...(quote.taxRate === undefined ? {} : { taxRate: quote.taxRate }),
    ...(quote.validUntil === undefined ? {} : { validUntil: quote.validUntil }),
    ...(quote.notes === undefined ? {} : { notes: quote.notes }),
    // The legacy Quote type predates `termsIncluded`; every migrated row is
    // marked as having included terms, matching how the rest of the app
    // already treats un-migrated legacy quotes (no separate toggle exists).
    termsIncluded: true,
    legacyCreatedAt: quote.createdAt,
    legacyUpdatedAt: quote.updatedAt,
  };
}

/**
 * Development-only, one-shot import of every quote in the legacy flat
 * `QuoteStore` into the controlled quote-revision lifecycle. Refuses outside
 * a `dev:`-prefixed deployment before touching anything; the target Convex
 * mutation (`quoteMigration.importLegacyQuote`) independently re-checks the
 * exact authorised development deployment, so this is defense in depth, not
 * the only guard. Never exported through HTTP, MCP, or tool actions.
 */
export async function migrateLegacyQuotes(
  legacyStore: QuoteStore,
  importLegacyQuote: ImportLegacyQuoteFn,
  serviceToken: string,
  deployment: string | undefined,
): Promise<LegacyQuoteMigrationSummary> {
  if (!deployment?.trim().startsWith("dev:")) {
    throw new Error(
      "Legacy quote migration refused: CONVEX_DEPLOYMENT must identify a development deployment (dev:...).",
    );
  }

  const quotes = await legacyStore.list();
  const results: LegacyQuoteImportResult[] = [];
  for (const quote of quotes) {
    results.push(await importLegacyQuote(mapLegacyQuote(quote, serviceToken, deployment)));
  }

  return {
    total: results.length,
    imported: results.filter((result) => result.status === "imported").length,
    rejected: results.filter((result) => result.status === "rejected").length,
    results,
  };
}
