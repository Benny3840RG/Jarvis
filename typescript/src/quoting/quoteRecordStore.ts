import type { Quote, QuoteStore } from "../quotes/quote.js";
import { calculateQuoteTotals } from "./quoteCalculator.js";
import { fromQuoteRecord, toQuoteInput } from "./quoteRecordAdapter.js";
import type { QuoteData } from "./quoteTypes.js";

export type QuoteRecordSummary = {
  quoteNumber: number;
  clientName: string;
  project: string;
  totalIncGst: number;
  issueDate: string;
};

function toSummary(record: Quote): QuoteRecordSummary | null {
  const data = fromQuoteRecord(record);
  if (!data) return null;
  return {
    quoteNumber: data.quoteNumber,
    clientName: data.client.name,
    project: data.project,
    totalIncGst: calculateQuoteTotals(data).totalIncGst,
    issueDate: data.issueDate,
  };
}

export async function saveQuoteRecord(store: QuoteStore, quote: QuoteData): Promise<Quote> {
  return store.add(toQuoteInput(quote));
}

export type AllocateAndSaveResult = {
  quote: QuoteData;
  saved: boolean;
  collisionDetected: boolean;
  error?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Allocates the next quote number and saves it as close together as this
 * shared, lock-free store allows, then checks whether another writer landed
 * the same number in that gap (`nextQuoteRecordNumber` + `add` isn't atomic —
 * `JsonQuoteStore` exposes no primitive for that, and adding one would mean
 * redesigning the shared persistence module). This doesn't make allocation
 * atomic; it narrows the race window from the whole interactive session down
 * to a single save, and reports a collision it still can't fully prevent
 * instead of silently letting two quotes share a number.
 */
export async function allocateAndSaveQuote(
  store: QuoteStore,
  quote: QuoteData,
): Promise<AllocateAndSaveResult> {
  let quoteNumber: number;
  try {
    quoteNumber = await nextQuoteRecordNumber(store);
  } catch (error: unknown) {
    return { quote, saved: false, collisionDetected: false, error: errorMessage(error) };
  }

  const finalQuote: QuoteData = { ...quote, quoteNumber };
  let saved: Quote;
  try {
    saved = await store.add(toQuoteInput(finalQuote));
  } catch (error: unknown) {
    return {
      quote: finalQuote,
      saved: false,
      collisionDetected: false,
      error: errorMessage(error),
    };
  }

  const records = await store.list();
  const collisionDetected = records.some(
    (record) => record.id !== saved.id && fromQuoteRecord(record)?.quoteNumber === quoteNumber,
  );
  return { quote: finalQuote, saved: true, collisionDetected };
}

/** Most recently created quotes first, capped at `limit`. Records not created by this module are skipped. */
export async function listRecentQuoteRecords(
  store: QuoteStore,
  limit = 20,
): Promise<QuoteRecordSummary[]> {
  const records = await store.list();
  const decoded: { summary: QuoteRecordSummary; createdAt: number; index: number }[] = [];
  records.forEach((record, index) => {
    const summary = toSummary(record);
    if (summary) decoded.push({ summary, createdAt: record.createdAt, index });
  });
  // store.list() returns insertion order; break same-millisecond createdAt ties by
  // that order so "most recent" stays well-defined even for rapid successive saves.
  decoded.sort((a, b) => b.createdAt - a.createdAt || b.index - a.index);
  return decoded.slice(0, limit).map((entry) => entry.summary);
}

/** The most recently created record with this quote number, or null if none exists. */
export async function findQuoteRecordByNumber(
  store: QuoteStore,
  quoteNumber: number,
): Promise<QuoteData | null> {
  const records = await store.list();
  let match: QuoteData | null = null;
  let matchCreatedAt = -Infinity;
  for (const record of records) {
    const data = fromQuoteRecord(record);
    if (data && data.quoteNumber === quoteNumber && record.createdAt >= matchCreatedAt) {
      match = data;
      matchCreatedAt = record.createdAt;
    }
  }
  return match;
}

function nativeQuoteNumber(record: Quote): number | null {
  if (!/^\d+$/.test(record.number)) return null;
  const parsed = Number(record.number);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * One past the highest quote number in use, or 1 if the store is empty. This
 * store (`typescript/data/jarvis-quotes.json` by default) is shared with the
 * HTTP daily brief and backup/restore, not exclusive to this module, so a
 * non-Jarvis record's native `number` field counts too whenever it happens to
 * be a plain positive integer — otherwise a freshly allocated number could
 * collide with a pre-existing quote this module never wrote.
 */
export async function nextQuoteRecordNumber(store: QuoteStore): Promise<number> {
  const records = await store.list();
  let max = 0;
  for (const record of records) {
    const data = fromQuoteRecord(record);
    if (data && data.quoteNumber > max) max = data.quoteNumber;
    const native = nativeQuoteNumber(record);
    if (native !== null && native > max) max = native;
  }
  return max + 1;
}
