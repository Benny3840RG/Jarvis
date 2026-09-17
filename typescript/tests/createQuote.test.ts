import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectQuoteData, type QuoteIntakeIo } from "../src/quoting/createQuote.js";
import { calculateQuoteTotals } from "../src/quoting/quoteCalculator.js";
import { renderQuoteText } from "../src/quoting/quoteRenderer.js";
import { quote176 } from "../src/quoting/fixtures/quote176.js";

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

describe("collectQuoteData", () => {
  it("builds a QuoteData matching Quote #176 from scripted answers", async () => {
    const io = new ScriptedIo(scriptForQuote176());
    const { write } = capture();

    const quote = await collectQuoteData(io, write, {
      quoteNumber: quote176.quoteNumber,
      issueDate: quote176.issueDate,
    });

    assert.equal(quote.client.name, quote176.client.name);
    assert.equal(quote.client.propertyAddress, quote176.client.propertyAddress);
    assert.equal(quote.project, quote176.project);
    assert.equal(quote.items.length, quote176.items.length);
    assert.deepEqual(quote.items, quote176.items);
    assert.deepEqual(quote.notes, quote176.notes);
    assert.equal(quote.validDays, 30);
    assert.equal(quote.depositPercentage, 30);

    const totals = calculateQuoteTotals(quote);
    assert.equal(totals.totalIncGst, 7570);
    assert.ok(Math.abs(totals.gstComponent - 688.1818181818181) < 1e-9);
    assert.equal(totals.deposit, 2271);
    assert.equal(totals.balance, 5299);
  });

  it("re-prompts on blank required fields, invalid amounts, and invalid y/n answers", async () => {
    const io = new ScriptedIo([
      "", // blank client name -> reprompt
      "Fiona Dabas",
      "16 King Orchid Drive, Langwarrin VIC 3910",
      "Pre-Auction Property Works",
      "maybe", // invalid y/n -> reprompt
      "y",
      "Back Deck work",
      "not-a-number", // invalid amount -> reprompt
      "-5", // non-positive amount -> reprompt
      "4850",
      "n", // no more items
      "n", // no notes
    ]);
    const { output, write } = capture();

    const quote = await collectQuoteData(io, write);

    assert.equal(quote.client.name, "Fiona Dabas");
    assert.equal(quote.items.length, 1);
    assert.equal(quote.items[0]?.amountIncGst, 4850);
    assert.equal(quote.notes.length, 0);
    assert.ok(output.some((line) => line.includes("can't be blank")));
    assert.ok(output.some((line) => line.includes('"y" or "n"')));
    assert.ok(output.some((line) => line.includes("positive number")));
  });
});

describe("renderQuoteText via interactive intake", () => {
  it("renders the same totals as the Quote #176 fixture demo", async () => {
    const io = new ScriptedIo(scriptForQuote176());
    const { write } = capture();

    const quote = await collectQuoteData(io, write, {
      quoteNumber: quote176.quoteNumber,
      issueDate: quote176.issueDate,
    });

    assert.equal(renderQuoteText(quote), renderQuoteText(quote176));
  });
});
