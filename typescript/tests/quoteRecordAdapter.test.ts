import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { quote176 } from "../src/quoting/fixtures/quote176.js";
import {
  decodeQuoteDataNote,
  encodeQuoteDataNote,
  isQuoteData,
} from "../src/quoting/quoteRecordAdapter.js";
import type { QuoteData } from "../src/quoting/quoteTypes.js";

describe("isQuoteData", () => {
  it("accepts the Quote #176 fixture", () => {
    assert.equal(isQuoteData(quote176), true);
  });

  it("rejects a calendar date that doesn't exist, even though Date would silently roll it over", () => {
    // new Date("2026-02-31T00:00:00") rolls over to March 3rd instead of rejecting it.
    assert.equal(isQuoteData({ ...quote176, issueDate: "2026-02-31" }), false);
    assert.equal(isQuoteData({ ...quote176, issueDate: "2026-04-31" }), false);
    assert.equal(isQuoteData({ ...quote176, issueDate: "2026-13-01" }), false);
  });

  it("accepts a real leap-day date and rejects the same day in a non-leap year", () => {
    assert.equal(isQuoteData({ ...quote176, issueDate: "2028-02-29" }), true);
    assert.equal(isQuoteData({ ...quote176, issueDate: "2026-02-29" }), false);
  });

  it("rejects a blank or malformed issue date string", () => {
    assert.equal(isQuoteData({ ...quote176, issueDate: "" }), false);
    assert.equal(isQuoteData({ ...quote176, issueDate: "not-a-date" }), false);
    assert.equal(isQuoteData({ ...quote176, issueDate: "07/30/2026" }), false);
  });

  it("rejects blank client name, property address, and project text", () => {
    assert.equal(isQuoteData({ ...quote176, client: { ...quote176.client, name: "  " } }), false);
    assert.equal(
      isQuoteData({ ...quote176, client: { ...quote176.client, propertyAddress: "" } }),
      false,
    );
    assert.equal(isQuoteData({ ...quote176, project: "" }), false);
  });

  it("rejects a blank line item description", () => {
    const items = [{ ...quote176.items[0]!, description: "   " }];
    assert.equal(isQuoteData({ ...quote176, items }), false);
  });

  it("rejects a fractional quote number", () => {
    assert.equal(isQuoteData({ ...quote176, quoteNumber: 1.5 }), false);
  });

  it("rejects a zero or negative quote number", () => {
    assert.equal(isQuoteData({ ...quote176, quoteNumber: 0 }), false);
    assert.equal(isQuoteData({ ...quote176, quoteNumber: -1 }), false);
  });

  it("rejects a deposit percentage outside 0-100", () => {
    assert.equal(isQuoteData({ ...quote176, depositPercentage: 150 }), false);
    assert.equal(isQuoteData({ ...quote176, depositPercentage: -10 }), false);
  });

  it("accepts a fractional deposit percentage within range", () => {
    assert.equal(isQuoteData({ ...quote176, depositPercentage: 33.3 }), true);
  });

  it("rejects a fractional or non-positive validDays", () => {
    assert.equal(isQuoteData({ ...quote176, validDays: 30.5 }), false);
    assert.equal(isQuoteData({ ...quote176, validDays: 0 }), false);
  });

  it("rejects a fractional or non-positive line item number", () => {
    const items = [{ ...quote176.items[0]!, number: 1.5 }];
    assert.equal(isQuoteData({ ...quote176, items }), false);
  });

  it("rejects a zero or negative line item amount", () => {
    const items = [{ ...quote176.items[0]!, amountIncGst: 0 }];
    assert.equal(isQuoteData({ ...quote176, items }), false);
  });
});

describe("encodeQuoteDataNote", () => {
  it("round-trips a valid QuoteData through decodeQuoteDataNote", () => {
    const note = encodeQuoteDataNote(quote176);
    assert.deepEqual(decodeQuoteDataNote(note), quote176);
  });

  it("refuses to encode a quote with a fractional quote number", () => {
    const invalid: QuoteData = { ...quote176, quoteNumber: 1.5 };
    assert.throws(() => encodeQuoteDataNote(invalid), /invalid quote/i);
  });

  it("refuses to encode a quote with an out-of-range deposit percentage", () => {
    const invalid: QuoteData = { ...quote176, depositPercentage: 150 };
    assert.throws(() => encodeQuoteDataNote(invalid), /invalid quote/i);
  });
});

describe("decodeQuoteDataNote", () => {
  it("rejects a corrupted/invalid payload that happens to carry the tag", () => {
    const corrupted = `jarvis-quote-data:v1:${JSON.stringify({ ...quote176, quoteNumber: 1.5 })}`;
    assert.equal(decodeQuoteDataNote(corrupted), null);
  });

  it("returns null for notes without the tag", () => {
    assert.equal(decodeQuoteDataNote("just a regular note"), null);
    assert.equal(decodeQuoteDataNote(undefined), null);
  });
});
