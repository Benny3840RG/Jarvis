import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryQuoteStore } from "../src/quotes/inMemoryQuoteStore.js";
import type { QuoteStore } from "../src/quotes/quote.js";
import { runCreateQuote, type QuoteIntakeIo } from "../src/quoting/createQuote.js";
import { quote176 } from "../src/quoting/fixtures/quote176.js";
import { calculateQuoteTotals } from "../src/quoting/quoteCalculator.js";
import {
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
});
