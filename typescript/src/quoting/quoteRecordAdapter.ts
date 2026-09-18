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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

function isQuoteItem(value: unknown): value is QuoteItem {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<QuoteItem>;
  return (
    isPositiveInteger(candidate.number) &&
    isNonBlankString(candidate.description) &&
    isPositiveAmount(candidate.amountIncGst)
  );
}

function isQuoteClient(value: unknown): value is QuoteClient {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<QuoteClient>;
  return isNonBlankString(candidate.name) && isNonBlankString(candidate.propertyAddress);
}

/**
 * Domain-valid QuoteData: a positive whole quote number (so
 * nextQuoteRecordNumber can never derive a fractional "next" number from a
 * corrupt record), a real calendar date, a positive whole valid-days period,
 * a 0-100 deposit percentage, non-blank client/project/description text, and
 * positive whole line-item numbers with positive amounts — matching what the
 * interactive intake itself already enforces, so a blank or malformed field
 * can't be saved and then render as an empty line or "Invalid Date".
 */
export function isQuoteData(value: unknown): value is QuoteData {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<QuoteData>;
  return (
    isPositiveInteger(candidate.quoteNumber) &&
    isIsoDate(candidate.issueDate) &&
    isPositiveInteger(candidate.validDays) &&
    isQuoteClient(candidate.client) &&
    isNonBlankString(candidate.project) &&
    Array.isArray(candidate.items) &&
    candidate.items.every(isQuoteItem) &&
    isPercentage(candidate.depositPercentage) &&
    Array.isArray(candidate.notes) &&
    candidate.notes.every((note) => typeof note === "string")
  );
}

/** Throws if `quote` violates the domain constraints `isQuoteData` checks, so invalid data is refused before it ever reaches the shared store. */
export function encodeQuoteDataNote(quote: QuoteData): string {
  if (!isQuoteData(quote)) {
    throw new Error("Refusing to save an invalid quote (violates quote data constraints).");
  }
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
