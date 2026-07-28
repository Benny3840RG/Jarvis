import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  QuotePdfError,
  renderFinalizedQuotePdf,
  type QuotePdfRenderInput,
} from "../src/quotes/quotePdfRenderer.js";
import type { QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";

const FINGERPRINT = `quote-revision:v1:sha256:${"a".repeat(64)}`;

function snapshot(overrides: Partial<QuoteSnapshot["revision"]> = {}): QuoteSnapshot {
  return {
    aggregate: {
      quoteId: "quote-1",
      ownerId: "owner-1",
      clientId: "client-1",
      number: "Q-2026-001",
      currentRevision: 1,
      currentRevisionId: "revision-1",
      aggregateVersion: 3,
      commercialStatus: "open",
      createdAt: Date.parse("2026-07-20T00:00:00.000Z"),
      updatedAt: Date.parse("2026-07-28T00:00:00.000Z"),
    },
    revision: {
      revisionId: "revision-1",
      ownerId: "owner-1",
      quoteId: "quote-1",
      revision: 1,
      revisionVersion: 3,
      status: "finalized",
      lineItems: [
        { description: "Deck preparation and sanding", quantity: 1, unitPrice: 850 },
        { description: "Two-coat exterior finish", quantity: 1, unitPrice: 420 },
      ],
      subtotal: 1_270,
      taxRate: 0.1,
      tax: 127,
      total: 1_397,
      currency: "AUD",
      validUntil: "2026-08-28",
      notes: "Thank you for the opportunity to quote.",
      termsIncluded: true,
      fingerprint: FINGERPRINT,
      finalizedAt: Date.parse("2026-07-28T00:00:00.000Z"),
      createdAt: Date.parse("2026-07-20T00:00:00.000Z"),
      updatedAt: Date.parse("2026-07-28T00:00:00.000Z"),
      ...overrides,
    },
  };
}

function input(revisionOverrides: Partial<QuoteSnapshot["revision"]> = {}): QuotePdfRenderInput {
  return {
    snapshot: snapshot(revisionOverrides),
    issuer: {
      name: "The Beez Treez Property Solutions",
      abn: "12 345 678 901",
      email: "quotes@example.com",
      phone: "0400 000 000",
      addressLines: ["Seaford VIC 3198"],
    },
    client: {
      name: "Fiona Dabas",
      email: "fiona@example.com",
      addressLines: ["16 King Orchid Drive", "Langwarrin VIC 3910"],
    },
    generatedAt: "2026-07-28T08:00:00.000Z",
  };
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof QuotePdfError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("renderFinalizedQuotePdf", () => {
  it("renders a deterministic finalized quote artefact", () => {
    const first = renderFinalizedQuotePdf(input());
    const second = renderFinalizedQuotePdf(input());

    assert.equal(first.mediaType, "application/pdf");
    assert.equal(first.filename, "Quote-Q-2026-001-R1.pdf");
    assert.match(first.digest, /^quote-pdf:v1:sha256:[a-f0-9]{64}$/);
    assert.equal(first.byteLength, first.bytes.byteLength);
    assert.equal(Buffer.from(first.bytes.subarray(0, 8)).toString("ascii"), "%PDF-1.7");
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.digest, second.digest);
  });

  it("fails closed for mutable or corrupt quote snapshots", () => {
    expectCode(() => renderFinalizedQuotePdf(input({ status: "reviewed" })), "quote-pdf-not-finalized");
    expectCode(
      () => renderFinalizedQuotePdf(input({ fingerprint: undefined })),
      "quote-pdf-fingerprint-invalid",
    );
    expectCode(
      () =>
        renderFinalizedQuotePdf({
          ...input(),
          snapshot: {
            ...input().snapshot,
            aggregate: { ...input().snapshot.aggregate, quoteId: "other-quote" },
          },
        }),
      "quote-pdf-identity-mismatch",
    );
    expectCode(
      () => renderFinalizedQuotePdf(input({ total: 1_398 })),
      "quote-pdf-totals-invalid",
    );
  });

  it("encodes hostile PDF syntax as data and sanitises the filename", () => {
    const hostile = input({
      lineItems: [
        {
          description: "Repair ) Tj ET /JavaScript (payload) % fake operator",
          quantity: 1,
          unitPrice: 100,
        },
      ],
      subtotal: 100,
      taxRate: 0.1,
      tax: 10,
      total: 110,
    });
    hostile.snapshot.aggregate.number = "../Q\\7 %";
    const artifact = renderFinalizedQuotePdf(hostile);
    const pdf = Buffer.from(artifact.bytes).toString("latin1");

    assert.equal(artifact.filename, "Quote-Q-7-R1.pdf");
    assert.doesNotMatch(pdf, /Repair \) Tj ET \/JavaScript/);
    assert.doesNotMatch(pdf, /\/JavaScript \(payload\)/);
  });

  it("paginates long quotes while repeating traceable footers", () => {
    const lineItems = Array.from({ length: 60 }, (_, index) => ({
      description: `Line ${index + 1}: remove, prepare and reinstate affected property area`,
      quantity: 1,
      unitPrice: 10,
    }));
    const artifact = renderFinalizedQuotePdf(
      input({ lineItems, subtotal: 600, taxRate: 0.1, tax: 60, total: 660 }),
    );
    const pdf = Buffer.from(artifact.bytes).toString("latin1");
    const pageCount = Number(/\/Count (\d+)/.exec(pdf)?.[1] ?? "0");

    assert.ok(pageCount >= 2);
    assert.equal((pdf.match(/quote-revision:v1:sha256:/g) ?? []).length, pageCount);
    for (let page = 1; page <= pageCount; page += 1) {
      assert.match(pdf, new RegExp(`Page ${page} of ${pageCount}`));
    }
  });
});
