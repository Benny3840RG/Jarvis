import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryQuoteStore } from "../src/quotes/inMemoryQuoteStore.js";
import type { Quote, QuoteStore } from "../src/quotes/quote.js";
import { runCreateQuote, type QuoteIntakeIo } from "../src/quoting/createQuote.js";
import { quote176 } from "../src/quoting/fixtures/quote176.js";
import { calculateQuoteTotals } from "../src/quoting/quoteCalculator.js";
import { fromQuoteRecord } from "../src/quoting/quoteRecordAdapter.js";
import {
  allocateAndSaveQuote,
  findQuoteRecordByNumber,
  listRecentQuoteRecords,
  nextQuoteRecordNumber,
  saveQuoteRecord,
} from "../src/quoting/quoteRecordStore.js";
import { renderQuoteText } from "../src/quoting/quoteRenderer.js";

class ScriptedIo implements QuoteIntakeIo {
  closed = false;

  constructor(private readonly lines: string[]) {}

  question(): Promise<string> {
    const next = this.lines.shift();
    if (next === undefined) throw new Error("ScriptedIo ran out of scripted answers");
    return Promise.resolve(next);
  }

  close(): void {
    this.closed = true;
  }
}

function capture() {
  const output: string[] = [];
  return { output, write: (line: string) => output.push(line) };
}

function scriptForQuote176(): string[] {
  const lines: string[] = [quote176.client.name, quote176.client.propertyAddress, quote176.project];
  for (const item of quote176.items) {
    lines.push("y", item.description, String(item.amountIncGst));
  }
  lines.push("n");
  lines.push("y", ...quote176.notes, "");
  return lines;
}

describe("runCreateQuote persistence", () => {
  it("saves the created quote to the store with matching data", async () => {
    const store = new InMemoryQuoteStore();
    const io = new ScriptedIo(scriptForQuote176());
    const { write } = capture();

    const quote = await runCreateQuote(
      io,
      write,
      { quoteNumber: quote176.quoteNumber, issueDate: quote176.issueDate },
      store,
    );

    const found = await findQuoteRecordByNumber(store, quote176.quoteNumber);
    assert.ok(found);
    assert.deepEqual(found, quote);
    assert.deepEqual(found, {
      ...quote176,
      quoteNumber: quote176.quoteNumber,
      issueDate: quote176.issueDate,
    });
  });

  it("still shows the quote when saving fails, and reports the failure", async () => {
    const failingStore: QuoteStore = {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      add: () => Promise.reject(new Error("disk full")),
      update: () => Promise.resolve(null),
      remove: () => Promise.resolve(null),
    };
    const io = new ScriptedIo(scriptForQuote176());
    const { output, write } = capture();

    const quote = await runCreateQuote(
      io,
      write,
      { quoteNumber: quote176.quoteNumber, issueDate: quote176.issueDate },
      failingStore,
    );

    assert.equal(quote.client.name, quote176.client.name);
    assert.ok(output.some((line) => line.includes(renderQuoteText(quote))));
    assert.ok(output.some((line) => line.includes("Could not save quote #176")));
    assert.ok(output.some((line) => line.includes("disk full")));
  });

  it("does not attempt to save when no store is supplied", async () => {
    const io = new ScriptedIo(scriptForQuote176());
    const { write } = capture();

    await runCreateQuote(io, write, { quoteNumber: quote176.quoteNumber });
  });

  it("auto-allocates the quote number from the store when none is pinned in options", async () => {
    const store = new InMemoryQuoteStore();
    await saveQuoteRecord(store, { ...quote176, quoteNumber: 40 });
    const io = new ScriptedIo(scriptForQuote176());
    const { output, write } = capture();

    const quote = await runCreateQuote(io, write, { issueDate: quote176.issueDate }, store);

    assert.equal(quote.quoteNumber, 41);
    assert.ok(output.some((line) => line.includes(renderQuoteText(quote))));
    const found = await findQuoteRecordByNumber(store, 41);
    assert.deepEqual(found, quote);
  });
});

describe("listRecentQuoteRecords", () => {
  it("returns summaries sorted most-recent-first, capped at the limit", async () => {
    const store = new InMemoryQuoteStore();
    for (let i = 1; i <= 25; i++) {
      await saveQuoteRecord(store, {
        ...quote176,
        quoteNumber: i,
        issueDate: `2026-01-${String(i).padStart(2, "0")}`,
      });
    }

    const summaries = await listRecentQuoteRecords(store, 20);

    assert.equal(summaries.length, 20);
    assert.equal(summaries[0]?.quoteNumber, 25);
    assert.equal(summaries[19]?.quoteNumber, 6);
    assert.deepEqual(summaries[0], {
      quoteNumber: 25,
      clientName: quote176.client.name,
      project: quote176.project,
      totalIncGst: calculateQuoteTotals(quote176).totalIncGst,
      issueDate: "2026-01-25",
    });
  });

  it("skips store records that were not created by this module", async () => {
    const store = new InMemoryQuoteStore();
    await store.add({ clientId: "someone", number: "legacy-1", lineItems: [] });
    await saveQuoteRecord(store, quote176);

    const summaries = await listRecentQuoteRecords(store);

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.quoteNumber, quote176.quoteNumber);
  });
});

describe("findQuoteRecordByNumber / show", () => {
  it("reproduces the exact rendered quote from creation time", async () => {
    const store = new InMemoryQuoteStore();
    await saveQuoteRecord(store, quote176);

    const found = await findQuoteRecordByNumber(store, quote176.quoteNumber);

    assert.ok(found);
    assert.equal(renderQuoteText(found), renderQuoteText(quote176));
  });

  it("returns null for a quote number that was never saved", async () => {
    const store = new InMemoryQuoteStore();
    await saveQuoteRecord(store, quote176);

    assert.equal(await findQuoteRecordByNumber(store, 999), null);
  });

  it("resolves to the most recently saved record when a number was reused", async () => {
    const store = new InMemoryQuoteStore();
    await saveQuoteRecord(store, { ...quote176, project: "First version" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveQuoteRecord(store, { ...quote176, project: "Second version" });

    const found = await findQuoteRecordByNumber(store, quote176.quoteNumber);

    assert.equal(found?.project, "Second version");
  });
});

describe("nextQuoteRecordNumber", () => {
  it("starts at 1 for an empty store", async () => {
    const store = new InMemoryQuoteStore();
    assert.equal(await nextQuoteRecordNumber(store), 1);
  });

  it("returns one past the highest saved quote number", async () => {
    const store = new InMemoryQuoteStore();
    await saveQuoteRecord(store, { ...quote176, quoteNumber: 5 });
    await saveQuoteRecord(store, { ...quote176, quoteNumber: 176 });
    await saveQuoteRecord(store, { ...quote176, quoteNumber: 40 });

    assert.equal(await nextQuoteRecordNumber(store), 177);
  });

  it("also accounts for plain-integer quote numbers on records this module didn't create", async () => {
    // This store is shared with the HTTP daily brief and backup/restore, not exclusive
    // to this module, so a pre-existing record's native `number` must not be reusable.
    const store = new InMemoryQuoteStore();
    await store.add({ clientId: "someone", number: "50", lineItems: [] });

    assert.equal(await nextQuoteRecordNumber(store), 51);
  });

  it("ignores non-integer native quote numbers from other systems", async () => {
    const store = new InMemoryQuoteStore();
    await store.add({ clientId: "someone", number: "BTQ-2026-07", lineItems: [] });

    assert.equal(await nextQuoteRecordNumber(store), 1);
  });
});

describe("allocateAndSaveQuote", () => {
  it("allocates the next number and saves under it", async () => {
    const store = new InMemoryQuoteStore();
    await saveQuoteRecord(store, { ...quote176, quoteNumber: 10 });

    const result = await allocateAndSaveQuote(store, quote176);

    assert.equal(result.saved, true);
    assert.equal(result.quote.quoteNumber, 11);
    assert.deepEqual(await findQuoteRecordByNumber(store, 11), result.quote);
  });

  // Simulates the race the store can't prevent: something else inserts a record
  // under the number we just allocated, between our add() and our own re-check.
  class RacyStore implements QuoteStore {
    constructor(
      private readonly inner: QuoteStore,
      private collisionsRemaining: number,
    ) {}
    list(): Promise<Quote[]> {
      return this.inner.list();
    }
    get(id: string): Promise<Quote | null> {
      return this.inner.get(id);
    }
    async add(input: Parameters<QuoteStore["add"]>[0]): Promise<Quote> {
      const saved = await this.inner.add(input);
      if (this.collisionsRemaining > 0) {
        this.collisionsRemaining--;
        await this.inner.add({ ...input, clientId: "racing-writer" });
      }
      return saved;
    }
    update(id: string, update: Parameters<QuoteStore["update"]>[1]): Promise<Quote | null> {
      return this.inner.update(id, update);
    }
    remove(id: string): Promise<Quote | null> {
      return this.inner.remove(id);
    }
  }

  it("self-heals a single detected collision by removing its duplicate and retrying", async () => {
    const store = new RacyStore(new InMemoryQuoteStore(), 1);

    const result = await allocateAndSaveQuote(store, quote176);

    assert.equal(result.saved, true);
    // The racing writer legitimately kept number 1; we retried onto number 2.
    assert.equal(result.quote.quoteNumber, 2);
    assert.deepEqual(await findQuoteRecordByNumber(store, 2), result.quote);
    const recordsAtNumber2 = (await store.list()).filter(
      (record) => fromQuoteRecord(record)?.quoteNumber === 2,
    );
    assert.equal(recordsAtNumber2.length, 1);
  });

  it("gives up after exhausting every attempt against a persistently racing writer", async () => {
    const store = new RacyStore(new InMemoryQuoteStore(), 1000);

    const result = await allocateAndSaveQuote(store, quote176, 3);

    assert.equal(result.saved, false);
    assert.ok(result.error);
  });

  it("still reports success when the post-save uniqueness check itself fails to read", async () => {
    class UnreadableAfterSaveStore implements QuoteStore {
      private addedOnce = false;
      constructor(private readonly inner: QuoteStore) {}
      async list(): Promise<Quote[]> {
        if (this.addedOnce) throw new Error("disk read failed");
        return this.inner.list();
      }
      get(id: string): Promise<Quote | null> {
        return this.inner.get(id);
      }
      async add(input: Parameters<QuoteStore["add"]>[0]): Promise<Quote> {
        const saved = await this.inner.add(input);
        this.addedOnce = true;
        return saved;
      }
      update(id: string, update: Parameters<QuoteStore["update"]>[1]): Promise<Quote | null> {
        return this.inner.update(id, update);
      }
      remove(id: string): Promise<Quote | null> {
        return this.inner.remove(id);
      }
    }
    const store = new UnreadableAfterSaveStore(new InMemoryQuoteStore());

    const result = await allocateAndSaveQuote(store, quote176);

    assert.equal(result.saved, true);
    assert.equal(result.quote.quoteNumber, 1);
    assert.match(result.warning ?? "", /could not confirm it's unique/);
  });

  it("detects a collision against a native (non-tagged) record sharing the same number", async () => {
    // A legacy or otherwise-shared-store writer that never used this module's
    // adapter still has a native `number` field, which must count too.
    class NativeCollisionOnceStore implements QuoteStore {
      private injected = false;
      constructor(private readonly inner: QuoteStore) {}
      list(): Promise<Quote[]> {
        return this.inner.list();
      }
      get(id: string): Promise<Quote | null> {
        return this.inner.get(id);
      }
      async add(input: Parameters<QuoteStore["add"]>[0]): Promise<Quote> {
        const saved = await this.inner.add(input);
        if (!this.injected) {
          this.injected = true;
          await this.inner.add({ clientId: "legacy-writer", number: input.number, lineItems: [] });
        }
        return saved;
      }
      update(id: string, update: Parameters<QuoteStore["update"]>[1]): Promise<Quote | null> {
        return this.inner.update(id, update);
      }
      remove(id: string): Promise<Quote | null> {
        return this.inner.remove(id);
      }
    }
    const store = new NativeCollisionOnceStore(new InMemoryQuoteStore());

    const result = await allocateAndSaveQuote(store, quote176);

    assert.equal(result.saved, true);
    assert.equal(result.quote.quoteNumber, 2);
  });

  it("stops immediately, without retrying, when cleaning up a detected duplicate fails", async () => {
    class AlwaysCollidesAndCannotRemove implements QuoteStore {
      addCalls = 0;
      constructor(private readonly inner: QuoteStore) {}
      list(): Promise<Quote[]> {
        return this.inner.list();
      }
      get(id: string): Promise<Quote | null> {
        return this.inner.get(id);
      }
      async add(input: Parameters<QuoteStore["add"]>[0]): Promise<Quote> {
        this.addCalls++;
        const saved = await this.inner.add(input);
        await this.inner.add({ ...input, clientId: "racing-writer" });
        return saved;
      }
      update(id: string, update: Parameters<QuoteStore["update"]>[1]): Promise<Quote | null> {
        return this.inner.update(id, update);
      }
      remove(): Promise<Quote | null> {
        return Promise.reject(new Error("remove failed"));
      }
    }
    const store = new AlwaysCollidesAndCannotRemove(new InMemoryQuoteStore());

    const result = await allocateAndSaveQuote(store, quote176, 5);

    assert.equal(result.saved, false);
    assert.match(result.error ?? "", /remove failed/);
    // Exactly one attempt: no retry after a failed cleanup.
    assert.equal(store.addCalls, 1);
  });
});
