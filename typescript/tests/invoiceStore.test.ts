import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryInvoiceStore } from "../src/invoices/inMemoryInvoiceStore.js";
import { JsonInvoiceStore } from "../src/invoices/jsonInvoiceStore.js";
import type { InvoiceStore } from "../src/invoices/invoice.js";

let dir: string;

function stores(): { name: string; make: () => InvoiceStore }[] {
  return [
    {
      name: "JsonInvoiceStore",
      make: () => new JsonInvoiceStore(path.join(dir, "invoices.json")),
    },
    { name: "InMemoryInvoiceStore", make: () => new InMemoryInvoiceStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-invoices-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("creates a draft invoice with server-derived GST totals and duplicate replay", async () => {
      const store = make();
      const invoice = await store.add({
        clientId: "c1",
        projectId: "p1",
        quoteId: "q1",
        number: "BTI-0001",
        taxRate: 0.1,
        duplicateKey: "job-p1-final",
        lineItems: [
          { description: "Labour", quantity: 2.5, unitPrice: 120 },
          { description: "Green waste", quantity: 1, unitPrice: 55 },
        ],
      });
      assert.equal(invoice.subtotal, 355);
      assert.equal(invoice.tax, 35.5);
      assert.equal(invoice.total, 390.5);
      assert.equal(invoice.balanceDue, 390.5);
      const replay = await store.add({
        clientId: "c1",
        number: "BTI-9999",
        duplicateKey: "job-p1-final",
      });
      assert.equal(replay.id, invoice.id);
      assert.equal((await store.list()).length, 1);
    });

    it("allows only draft updates, then records partial, full and over payments", async () => {
      const store = make();
      const invoice = await store.add({
        clientId: "c1",
        number: "BTI-0002",
        taxRate: 0.1,
        lineItems: [{ description: "Repair", quantity: 1, unitPrice: 100 }],
      });
      const issued = await store.issue(invoice.id);
      assert.equal(issued?.status, "issued");
      await assert.rejects(
        () => store.update(invoice.id, { notes: "late change" }),
        /Only draft invoices can be updated/,
      );
      const partial = await store.recordPayment(invoice.id, { amount: 55, reference: "bank-1" });
      assert.equal(partial?.paymentStatus, "partial");
      assert.equal(partial?.balanceDue, 55);
      const paid = await store.recordPayment(invoice.id, { amount: 55, reference: "bank-2" });
      assert.equal(paid?.status, "paid");
      assert.equal(paid?.paymentStatus, "paid");
      const overpaid = await store.recordPayment(invoice.id, { amount: 5, reference: "bank-3" });
      assert.equal(overpaid?.status, "issued");
      assert.equal(overpaid?.paymentStatus, "overpaid");
      assert.equal(overpaid?.balanceDue, -5);
    });

    it("rejects empty issue, payment before issue, paid voiding and bad amounts", async () => {
      const store = make();
      const draft = await store.add({ clientId: "c1", number: "BTI-0003" });
      await assert.rejects(() => store.issue(draft.id), /at least one line item/);
      await assert.rejects(
        () => store.recordPayment(draft.id, { amount: 1 }),
        /Payments can only be recorded/,
      );
      const invoice = await store.add({
        clientId: "c1",
        number: "BTI-0004",
        lineItems: [{ description: "Clean-up", quantity: 1, unitPrice: 25 }],
      });
      await store.issue(invoice.id);
      await assert.rejects(() => store.recordPayment(invoice.id, { amount: 0 }), /positive/);
      await store.recordPayment(invoice.id, { amount: 10 });
      await assert.rejects(() => store.void(invoice.id, "Mistake"), /cannot be voided/);
    });
  });
}

describe("JsonInvoiceStore durability", () => {
  it("reads back invoice and payments through a fresh instance", async () => {
    const file = path.join(dir, "invoices.json");
    const first = new JsonInvoiceStore(file);
    const invoice = await first.add({
      clientId: "c1",
      number: "BTI-0005",
      lineItems: [{ description: "Garden tidy", quantity: 1, unitPrice: 100 }],
    });
    await first.issue(invoice.id);
    await first.recordPayment(invoice.id, { amount: 40, reference: "receipt-1" });
    const reopened = new JsonInvoiceStore(file);
    const read = await reopened.get(invoice.id);
    assert.equal(read?.paymentStatus, "partial");
    assert.equal(read?.payments[0]?.reference, "receipt-1");
  });
});
