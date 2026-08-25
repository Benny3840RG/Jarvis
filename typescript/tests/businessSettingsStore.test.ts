import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InMemoryBusinessSettingsStore } from "../src/businessSettings/inMemoryBusinessSettingsStore.js";
import { JsonBusinessSettingsStore } from "../src/businessSettings/jsonBusinessSettingsStore.js";
import type { BusinessSettingsStore } from "../src/businessSettings/businessSettings.js";

let dir: string;

function stores(): { name: string; make: () => BusinessSettingsStore }[] {
  return [
    {
      name: "JsonBusinessSettingsStore",
      make: () => new JsonBusinessSettingsStore(path.join(dir, "settings.json")),
    },
    { name: "InMemoryBusinessSettingsStore", make: () => new InMemoryBusinessSettingsStore() },
  ];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jarvis-business-settings-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const { name, make } of stores()) {
  describe(name, () => {
    it("returns Beez Treez Australian defaults without secrets", async () => {
      const settings = await make().get();
      assert.equal(settings.businessName, "THE BEEZ TREEZ PROPERTY SOLUTIONS");
      assert.equal(settings.locale, "en-AU");
      assert.equal(settings.timezone, "Australia/Melbourne");
      assert.equal(settings.currency, "AUD");
      assert.equal(settings.measurementSystem, "metric");
      assert.equal(settings.pricing.gstRateBps, 1000);
      assert.equal(settings.numbering.quotePrefix, "BTQ");
      assert.equal(settings.numbering.invoicePrefix, "BTI");
    });

    it("updates contact, payment, pricing, and numbering settings", async () => {
      const store = make();
      const before = await store.get();
      await new Promise((resolve) => setTimeout(resolve, 2));
      const updated = await store.update({
        contactDetails: {
          email: "admin@beeztreez.example",
          phone: "0400 000 000",
        },
        paymentDetails: {
          bankName: "Example Bank",
          accountName: "The Beez Treez",
          bsb: "123-456",
          accountNumber: "12345678",
        },
        pricing: {
          defaultLabourRateCents: 8500,
          defaultMaterialsMarkupBps: 2500,
          defaultMarginBps: 3000,
        },
        numbering: {
          quotePrefix: "btq",
          nextQuoteNumber: 42,
          invoicePrefix: "bti",
          nextInvoiceNumber: 12,
        },
      });

      assert.equal(updated.contactDetails.email, "admin@beeztreez.example");
      assert.equal(updated.paymentDetails.bsb, "123-456");
      assert.equal(updated.pricing.defaultLabourRateCents, 8500);
      assert.equal(updated.pricing.defaultMaterialsMarkupBps, 2500);
      assert.equal(updated.numbering.quotePrefix, "BTQ");
      assert.equal(updated.numbering.nextQuoteNumber, 42);
      assert.ok(updated.updatedAt > before.updatedAt);
    });

    it("clears optional business and payment fields without clearing base settings", async () => {
      const store = make();
      await store.update({
        contactDetails: { website: "https://beeztreez.example" },
        paymentDetails: { paymentReferenceTemplate: "Quote {quoteNumber}" },
      });
      const cleared = await store.update({
        contactDetails: { website: null },
        paymentDetails: { paymentReferenceTemplate: null },
      });
      assert.equal(cleared.contactDetails.website, undefined);
      assert.equal(cleared.paymentDetails.paymentReferenceTemplate, undefined);
      assert.equal(cleared.currency, "AUD");
      assert.equal(cleared.measurementSystem, "metric");
    });

    it("rejects invalid rates, numbering, and secret-looking values", async () => {
      const store = make();
      await assert.rejects(
        () => store.update({ pricing: { defaultLabourRateCents: -1 } }),
        /Default labour rate/,
      );
      await assert.rejects(
        () => store.update({ numbering: { nextInvoiceNumber: 0 } }),
        /Next invoice number/,
      );
      await assert.rejects(
        () => store.update({ numbering: { quotePrefix: "BT Q" } }),
        /Quote prefix/,
      );
      await assert.rejects(
        () => store.update({ paymentDetails: { accountName: "password hunter2" } }),
        /must not contain credentials/,
      );
    });
  });
}

describe("JsonBusinessSettingsStore durability", () => {
  it("reads settings back through a fresh instance", async () => {
    const file = path.join(dir, "settings.json");
    const first = new JsonBusinessSettingsStore(file);
    await first.update({
      pricing: { defaultTravelRateCents: 1500 },
      numbering: { nextQuoteNumber: 101 },
    });

    const reopened = new JsonBusinessSettingsStore(file);
    const settings = await reopened.get();
    assert.equal(settings.pricing.defaultTravelRateCents, 1500);
    assert.equal(settings.numbering.nextQuoteNumber, 101);
  });
});
