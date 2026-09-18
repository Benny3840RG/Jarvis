import type { Quote, QuoteInput } from "../quotes/quote.js";
import type { QuoteClient, QuoteData, QuoteItem } from "./quoteTypes.js";

/**
 * The existing flat Quote/QuoteStore schema (src/quotes/quote.ts) predates this
 * module: it keys clients and projects by id, splits amounts into
 * quantity/unitPrice plus a single taxRate, and has no property address,
 * deposit percentage, valid-until period, or multi-line notes. None of that
 * fits QuoteData, and the task is to reuse this store, not redesign it. So the
 * full QuoteData is round-tripped verbatim as a tagged JSON blob in the one
 * free-text field the schema already has (`notes`), while the store's native
 * typed fields (clientId, number, lineItems, taxRate 0 so total == totalIncGst)
 * are populated too, so a plain listing of the raw store still looks sane.
 */
const QUOTE_DATA_NOTES_TAG = "jarvis-quote-data:v1:";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isQuoteItem(value: unknown): value is QuoteItem {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<QuoteItem>;
  return (
    isFiniteNumber(candidate.number) &&
    typeof candidate.description === "string" &&
    isFiniteNumber(candidate.amountIncGst)
  );
}

function isQuoteClient(value: unknown): value is QuoteClient {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<QuoteClient>;
  return typeof candidate.name === "string" && typeof candidate.propertyAddress === "string";
}

export function isQuoteData(value: unknown): value is QuoteData {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<QuoteData>;
  return (
    isFiniteNumber(candidate.quoteNumber) &&
    typeof candidate.issueDate === "string" &&
    isFiniteNumber(candidate.validDays) &&
    isQuoteClient(candidate.client) &&
    typeof candidate.project === "string" &&
    Array.isArray(candidate.items) &&
    candidate.items.every(isQuoteItem) &&
    isFiniteNumber(candidate.depositPercentage) &&
    Array.isArray(candidate.notes) &&
    candidate.notes.every((note) => typeof note === "string")
  );
}

export function encodeQuoteDataNote(quote: QuoteData): string {
  return `${QUOTE_DATA_NOTES_TAG}${JSON.stringify(quote)}`;
}

export function decodeQuoteDataNote(notes: string | undefined): QuoteData | null {
  if (!notes || !notes.startsWith(QUOTE_DATA_NOTES_TAG)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(notes.slice(QUOTE_DATA_NOTES_TAG.length));
  } catch {
    return null;
  }
  return isQuoteData(parsed) ? parsed : null;
}

export function toQuoteInput(quote: QuoteData): QuoteInput {
  return {
    clientId: quote.client.name,
    number: String(quote.quoteNumber),
    lineItems: quote.items.map((item) => ({
      description: item.description,
      quantity: 1,
      unitPrice: item.amountIncGst,
    })),
    taxRate: 0,
    notes: encodeQuoteDataNote(quote),
  };
}

/** Recovers the original QuoteData from a stored record, or null if it wasn't created by this module. */
export function fromQuoteRecord(record: Quote): QuoteData | null {
  return decodeQuoteDataNote(record.notes);
}
