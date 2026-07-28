import type {
  QuoteCommercialStatus,
  QuoteDraftPatch,
  QuoteHistoricalOutcome,
  QuoteRevisionLineItem,
  QuoteRevisionStatus,
  QuoteSnapshot,
} from "./quoteLifecycle.js";
import type { QuotePdfParty } from "./quotePdfRenderer.js";

export type CreateQuoteInput = {
  clientId: string;
  projectId?: string;
  number: string;
  lineItems: QuoteRevisionLineItem[];
  taxRate?: number;
  validUntil?: string;
  notes?: string;
  termsIncluded: boolean;
  currency?: "AUD";
};

export type ListQuotesInput = {
  clientId?: string;
  projectId?: string;
  commercialStatus?: QuoteCommercialStatus;
  limit?: number;
};

export type QuoteSummary = {
  quoteId: string;
  clientId: string;
  projectId?: string;
  number: string;
  currentRevision: number;
  aggregateVersion: number;
  revisionStatus: QuoteRevisionStatus;
  commercialStatus: QuoteCommercialStatus;
  total: number;
  currency: "AUD";
  updatedAt: number;
};

export type UpdateQuoteDraftInput = {
  quoteId: string;
  revision: number;
  expectedAggregateVersion: number;
  expectedRevisionVersion: number;
  patch: QuoteDraftPatch;
};

export type QuoteRevisionCommand = {
  quoteId: string;
  revision: number;
  expectedAggregateVersion: number;
  expectedRevisionVersion: number;
};

export type FinalizeQuoteRevisionInput = QuoteRevisionCommand & {
  issuer: QuotePdfParty;
  client: QuotePdfParty;
  generatedAt: string;
};

export type CreateQuoteRevisionInput = {
  quoteId: string;
  revision: number;
  expectedAggregateVersion: number;
  expectedRevisionVersion: number;
  expectedFingerprint: string;
};

export type RecordQuoteCommercialOutcomeInput = {
  quoteId: string;
  revision: number;
  expectedAggregateVersion: number;
  outcome: QuoteHistoricalOutcome;
  recordedAt?: number;
};

export interface QuoteRepository {
  createQuote(input: CreateQuoteInput): Promise<QuoteSnapshot>;
  getQuote(quoteId: string): Promise<QuoteSnapshot | null>;
  listQuotes(input: ListQuotesInput): Promise<QuoteSummary[]>;
  updateDraft(input: UpdateQuoteDraftInput): Promise<QuoteSnapshot>;
  submitForReview(input: QuoteRevisionCommand): Promise<QuoteSnapshot>;
  reopenForEditing(input: QuoteRevisionCommand): Promise<QuoteSnapshot>;
  finalizeRevision(input: FinalizeQuoteRevisionInput): Promise<QuoteSnapshot>;
  createRevisionFromFinalized(input: CreateQuoteRevisionInput): Promise<QuoteSnapshot>;
  recordCommercialOutcome(input: RecordQuoteCommercialOutcomeInput): Promise<QuoteSnapshot>;
  /** Development-only teardown of a quote and all its revisions. See `convex/quotes.ts#cleanup`. */
  cleanup(quoteId: string): Promise<boolean>;
}
