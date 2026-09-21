import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculateQuoteTotals } from "../src/quoting/quoteCalculator.js";
import { renderQuoteText } from "../src/quoting/quoteRenderer.js";
import { quote176 } from "../src/quoting/fixtures/quote176.js";

describe("calculateQuoteTotals", () => {
  it("computes totals for quote #176", () => {
    const totals = calculateQuoteTotals(quote176);
    assert.equal(totals.totalIncGst, 7570);
    assert.ok(Math.abs(totals.totalExGst - 6881.818181818182) < 1e-9);
    assert.ok(Math.abs(totals.gstComponent - 688.1818181818181) < 1e-9);
    assert.equal(totals.deposit, 2271);
    assert.equal(totals.balance, 5299);
  });
});

describe("renderQuoteText", () => {
  it("includes branding, items and totals for quote #176", () => {
    const text = renderQuoteText(quote176);
    assert.match(text, /THE BEEZ TREEZ PROPERTY SOLUTIONS/);
    assert.match(text, /14 796 994 912/);
    assert.match(text, /0413 926 324/);
    assert.match(text, /TheBeezTreez@outlook\.com/);
    assert.match(text, /QUOTE #176/);
    assert.match(text, /Fiona Dabas/);
    assert.match(text, /16 King Orchid Drive, Langwarrin VIC 3910/);
    for (const item of quote176.items) {
      assert.match(
        text,
        new RegExp(`${item.number}\\. ${item.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    }
    assert.match(text, /\$7,570\.00/);
    assert.match(text, /\$2,271\.00/);
    assert.match(text, /\$5,299\.00/);
    assert.match(text, /313-140/);
    assert.match(text, /12553206/);
  });
});
