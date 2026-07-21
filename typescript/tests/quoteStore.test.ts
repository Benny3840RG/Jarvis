import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryQuoteStore } from "../src/quotes/inMemoryQuoteStore.js";
import { JsonQuoteStore } from "../src/quotes/jsonQuoteStore.js";
import type { QuoteStore } from "../src/quotes/quote.js";

let dir: string;

function stores(): { name: string; make: () => QuoteStore }[] {
  return [
    { name: "JsonQuoteStore", make: () => new JsonQuoteStore(path.join(dir, "quotes.json")) },
    { name: "InMemoryQuoteStore", make: () => new InMemoryQuoteStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-quotes-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("derives subtotal, tax, and total from line items and a tax rate", async () => {
      const store = make();
      const quote = await store.add({
        clientId: "c1",
        number: "Q-1001",
        taxRate: 0.1,
        lineItems: [
          { description: "Labour", quantity: 3, unitPrice: 80 },
          { description: "Timber", quantity: 2, unitPrice: 45.5 },
        ],
      });
      assert.equal(quote.subtotal, 331);
      assert.equal(quote.tax, 33.1);
      assert.equal(quote.total, 364.1);
      assert.equal(quote.status, "draft");
      assert.ok(quote.id.length > 0);
      assert.equal(quote.createdAt, quote.updatedAt);
    });

    it("defaults to no tax when no rate is given", async () => {
      const store = make();
      const quote = await store.add({
        clientId: "c1",
        number: "Q-1002",
        lineItems: [{ description: "Callout", quantity: 1, unitPrice: 120 }],
      });
      assert.equal(quote.subtotal, 120);
      assert.equal(quote.tax, 0);
      assert.equal(quote.total, 120);
      assert.equal(quote.taxRate, undefined);
    });

    it("rejects a blank number, invalid tax rate, and bad line items", async () => {
      const store = make();
      await assert.rejects(
        () => store.add({ clientId: "c1", number: " " }),
        /number cannot be empty/,
      );
      await assert.rejects(
        () => store.add({ clientId: " ", number: "Q-1" }),
        /clientId cannot be empty/,
      );
      await assert.rejects(
        () => store.add({ clientId: "c1", number: "Q-1", taxRate: 1.5 }),
        /taxRate/,
      );
      await assert.rejects(
        () =>
          store.add({
            clientId: "c1",
            number: "Q-1",
            lineItems: [{ description: "X", quantity: -1, unitPrice: 5 }],
          }),
        /quantity must be a non-negative number/,
      );
    });

    it("recomputes totals when line items are replaced", async () => {
      const store = make();
      const quote = await store.add({
        clientId: "c1",
        number: "Q-1003",
        taxRate: 0.1,
        lineItems: [{ description: "Draft", quantity: 1, unitPrice: 100 }],
      });
      const updated = await store.update(quote.id, {
        lineItems: [
          { description: "Revised", quantity: 2, unitPrice: 100 },
          { description: "Extra", quantity: 1, unitPrice: 50 },
        ],
      });
      assert.equal(updated?.subtotal, 250);
      assert.equal(updated?.tax, 25);
      assert.equal(updated?.total, 275);
      assert.ok((updated?.updatedAt ?? 0) >= quote.updatedAt);
    });

    it("moves through statuses and clears notes with null", async () => {
      const store = make();
      const quote = await store.add({
        clientId: "c1",
        number: "Q-1004",
        notes: "chase deposit",
        lineItems: [{ description: "Job", quantity: 1, unitPrice: 200 }],
      });
      const sent = await store.update(quote.id, { status: "sent" });
      assert.equal(sent?.status, "sent");
      const accepted = await store.update(quote.id, { status: "accepted", notes: null });
      assert.equal(accepted?.status, "accepted");
      assert.equal(accepted?.notes, undefined);
    });

    it("clears the tax rate with null and recomputes totals", async () => {
      const store = make();
      const quote = await store.add({
        clientId: "c1",
        number: "Q-1005",
        taxRate: 0.1,
        lineItems: [{ description: "Job", quantity: 1, unitPrice: 100 }],
      });
      assert.equal(quote.tax, 10);
      const cleared = await store.update(quote.id, { taxRate: null });
      assert.equal(cleared?.taxRate, undefined);
      assert.equal(cleared?.tax, 0);
      assert.equal(cleared?.total, 100);
    });

    it("rejects an empty update on an existing quote", async () => {
      const store = make();
      const quote = await store.add({ clientId: "c1", number: "Q-1006" });
      await assert.rejects(() => store.update(quote.id, {}), /at least one changed field/);
    });

    it("returns null for unknown ids and removes a quote", async () => {
      const store = make();
      assert.equal(await store.get("nope"), null);
      assert.equal(await store.update("nope", { status: "sent" }), null);
      assert.equal(await store.remove("nope"), null);
      const quote = await store.add({ clientId: "c1", number: "Q-1007" });
      assert.equal((await store.remove(quote.id))?.id, quote.id);
      assert.deepEqual(await store.list(), []);
    });
  });
}

describe("JsonQuoteStore durability", () => {
  it("reads back derived totals through a fresh instance", async () => {
    const first = new JsonQuoteStore(path.join(dir, "quotes.json"));
    const added = await first.add({
      clientId: "c1",
      number: "Q-2001",
      status: "sent",
      taxRate: 0.1,
      lineItems: [{ description: "Fence", quantity: 4, unitPrice: 25 }],
    });
    const reopened = new JsonQuoteStore(path.join(dir, "quotes.json"));
    const list = await reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, added.id);
    assert.equal(list[0].status, "sent");
    assert.equal(list[0].subtotal, 100);
    assert.equal(list[0].tax, 10);
    assert.equal(list[0].total, 110);
  });
});
