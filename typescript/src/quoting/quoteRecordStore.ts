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
  error?: string;
  /** Set when `saved` is true but uniqueness couldn't be confirmed — the write happened, but a concurrent duplicate may still exist undetected. */
  warning?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_MAX_ALLOCATION_ATTEMPTS = 5;
const WINNER_SETTLE_DELAY_MS = 25;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordQuoteNumber(record: Quote): number | null {
  return fromQuoteRecord(record)?.quoteNumber ?? nativeQuoteNumber(record);
}

/** Deterministic ordering (earliest createdAt, id as a tiebreak) so two writers computing this over the same data always agree on the same winner without talking to each other. */
function isEarlierClaim(a: Quote, b: Quote): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id < b.id;
}

type WinnerCheck =
  | { outcome: "won" }
  | { outcome: "lost" }
  | { outcome: "vanished" }
  | { outcome: "unreadable"; error: unknown };

/** Reads every record sharing `quoteNumber` right now and reports whether `ownRecordId` is the deterministic winner among them. */
async function checkWinner(
  store: QuoteStore,
  quoteNumber: number,
  ownRecordId: string,
): Promise<WinnerCheck> {
  let records: Quote[];
  try {
    records = await store.list();
  } catch (error: unknown) {
    return { outcome: "unreadable", error };
  }
  const contenders = records.filter((record) => recordQuoteNumber(record) === quoteNumber);
  const ownRecord = contenders.find((record) => record.id === ownRecordId);
  if (!ownRecord) return { outcome: "vanished" };
  const winner = contenders.reduce((best, record) =>
    isEarlierClaim(record, best) ? record : best,
  );
  return winner.id === ownRecordId ? { outcome: "won" } : { outcome: "lost" };
}

/**
 * Allocates the next quote number and saves it as close together as this
 * shared, lock-free store allows (`nextQuoteRecordNumber` + `add` isn't
 * atomic — `JsonQuoteStore` exposes no locking primitive for that, and
 * adding one would mean redesigning the shared persistence module). After
 * saving, it re-reads the store for every record sharing that number and
 * picks a winner by a rule any concurrent caller reading the same data would
 * compute identically (`isEarlierClaim`) — so if two writers raced to the
 * same number, only the loser removes its own record and retries, rather
 * than both reacting to "a collision exists" and both tearing their write
 * down.
 *
 * That first check alone is not enough: it can only see contenders that have
 * already written by the time it reads, so the very first writer to check
 * can find itself alone, declare victory, and return — before a second
 * writer (whose record would have outranked it under the same rule) has
 * even landed. So an apparent win is re-verified once more after
 * `WINNER_SETTLE_DELAY_MS`, giving a near-simultaneous late arrival a chance
 * to show up before this call commits to success. This shrinks that window;
 * it cannot close it — no amount of re-checking can prove nothing arrives a
 * moment later without an actual lock, which this shared store doesn't
 * provide. Exhausting every attempt is returned as a failure rather than
 * thrown, so the caller can still show the collected quote even when
 * persistence didn't succeed.
 */
export async function allocateAndSaveQuote(
  store: QuoteStore,
  quote: QuoteData,
  maxAttempts = DEFAULT_MAX_ALLOCATION_ATTEMPTS,
): Promise<AllocateAndSaveResult> {
  let lastFailure: AllocateAndSaveResult = {
    quote,
    saved: false,
    error: "Could not allocate a unique quote number.",
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let quoteNumber: number;
    try {
      quoteNumber = await nextQuoteRecordNumber(store);
    } catch (error: unknown) {
      return { quote, saved: false, error: errorMessage(error) };
    }

    const finalQuote: QuoteData = { ...quote, quoteNumber };
    let saved: Quote;
    try {
      saved = await store.add(toQuoteInput(finalQuote));
    } catch (error: unknown) {
      return { quote: finalQuote, saved: false, error: errorMessage(error) };
    }

    let check = await checkWinner(store, quoteNumber, saved.id);
    if (check.outcome === "unreadable") {
      // The save itself already succeeded; a failure to re-read for the
      // uniqueness check is not a save failure — report success rather than
      // losing an already-persisted quote over it. But don't pretend
      // uniqueness was confirmed when it wasn't: flag it so the caller can
      // warn, rather than silently risking an undetected duplicate number.
      return {
        quote: finalQuote,
        saved: true,
        warning: `Saved as quote #${quoteNumber}, but could not confirm it's unique (${errorMessage(check.error)}) — run "npm run quotes:list" to check for a duplicate.`,
      };
    }
    if (check.outcome === "vanished") {
      return {
        quote: finalQuote,
        saved: false,
        error: `Quote number ${quoteNumber} was saved but the record could not be found in a follow-up read.`,
      };
    }

    if (check.outcome === "won") {
      // Confirm again after a short settle window: the first check can only
      // see writers that had already landed, so a near-simultaneous late
      // arrival that would outrank us under the same rule might not have
      // shown up yet.
      await delay(WINNER_SETTLE_DELAY_MS);
      check = await checkWinner(store, quoteNumber, saved.id);
      if (check.outcome === "unreadable") return { quote: finalQuote, saved: true };
      if (check.outcome === "vanished") {
        return {
          quote: finalQuote,
          saved: false,
          error: `Quote number ${quoteNumber} was saved but the record could not be found on the settle re-check.`,
        };
      }
      if (check.outcome === "won") return { quote: finalQuote, saved: true };
    }

    // Lost (either check): a concurrent writer holds the same number under
    // the same rule. Undo our own record before retrying — not the winner's
    // — so both sides never remove their own write for the same collision.
    try {
      const removed = await store.remove(saved.id);
      if (!removed) {
        return {
          quote: finalQuote,
          saved: false,
          error: `Quote number ${quoteNumber} collided with another record, and the duplicate this call created (id ${saved.id}) was not found to remove — it may be left behind in the store.`,
        };
      }
    } catch (error: unknown) {
      return {
        quote: finalQuote,
        saved: false,
        error: `Quote number ${quoteNumber} collided with another record, and removing the duplicate this call created failed (${errorMessage(error)}) — it is likely still in the store.`,
      };
    }

    lastFailure = {
      quote: finalQuote,
      saved: false,
      error: `Quote number ${quoteNumber} was claimed by a concurrent save; retried.`,
    };
  }

  return lastFailure;
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
