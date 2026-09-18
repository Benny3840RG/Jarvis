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

/** One past the highest quote number already saved, or 1 if the store has no Jarvis-created quotes yet. */
export async function nextQuoteRecordNumber(store: QuoteStore): Promise<number> {
  const records = await store.list();
  let max = 0;
  for (const record of records) {
    const data = fromQuoteRecord(record);
    if (data && data.quoteNumber > max) max = data.quoteNumber;
  }
  return max + 1;
}
