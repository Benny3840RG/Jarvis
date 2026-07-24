import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeQuoteRecipient,
  quoteRevisionFingerprint,
  quoteSendFingerprint,
  QuoteRecipientInvalidError,
  type QuoteRevisionFingerprintInput,
  type QuoteSendFingerprintInput,
} from "../src/quotes/quoteFingerprints.js";

function revisionFingerprintInput(
  overrides: Partial<QuoteRevisionFingerprintInput> = {},
): QuoteRevisionFingerprintInput {
  return {
    ownerId: "owner-1",
    quoteId: "quote-1",
    revision: 1,
    clientId: "client-1",
    projectId: "project-1",
    number: "BT-2026-001",
    lineItems: [{ description: "Labour", quantity: 2, unitPrice: 100 }],
    subtotal: 200,
    taxRate: 0.1,
    tax: 20,
    total: 220,
    currency: "AUD",
    validUntil: "2026-08-24",
    notes: "Includes cleanup",
    termsIncluded: true,
    ...overrides,
  };
}

function sendFingerprintInput(
  overrides: Partial<QuoteSendFingerprintInput> = {},
): QuoteSendFingerprintInput {
  return {
    ownerId: "owner-1",
    quoteId: "quote-1",
    revision: 1,
    revisionFingerprint: "quote-revision:v1:sha256:abc123",
    recipient: "Client@Example.com ",
    channel: "email",
    ...overrides,
  };
}

describe("quote fingerprints", () => {
  it("produces the same revision fingerprint for canonical-equivalent objects", () => {
    const first = revisionFingerprintInput({ notes: undefined });
    const second: QuoteRevisionFingerprintInput = {
      termsIncluded: true,
      notes: undefined,
      validUntil: "2026-08-24",
      currency: "AUD",
      total: 220,
      tax: 20,
      taxRate: 0.1,
      subtotal: 200,
      lineItems: [{ unitPrice: 100, quantity: 2, description: "Labour" }],
      number: "BT-2026-001",
      projectId: "project-1",
      clientId: "client-1",
      revision: 1,
      quoteId: "quote-1",
      ownerId: "owner-1",
    };

    assert.equal(quoteRevisionFingerprint(first), quoteRevisionFingerprint(second));
    assert.match(quoteRevisionFingerprint(first), /^quote-revision:v1:sha256:[a-f0-9]{64}$/);
  });

  it("changes the revision fingerprint when commercial content changes", () => {
    const base = revisionFingerprintInput();

    assert.notEqual(
      quoteRevisionFingerprint(base),
      quoteRevisionFingerprint({ ...base, total: 221 }),
    );
    assert.notEqual(
      quoteRevisionFingerprint(base),
      quoteRevisionFingerprint({ ...base, notes: "Different terms" }),
    );
  });

  it("rejects non-finite commercial numbers before hashing", () => {
    assert.throws(
      () => quoteRevisionFingerprint(revisionFingerprintInput({ total: Number.NaN })),
      /finite/,
    );
    assert.throws(
      () =>
        quoteRevisionFingerprint(
          revisionFingerprintInput({
            lineItems: [{ description: "Labour", quantity: Number.POSITIVE_INFINITY, unitPrice: 100 }],
          }),
        ),
      /finite/,
    );
  });

  it("normalizes recipients before producing a send fingerprint", () => {
    assert.equal(normalizeQuoteRecipient("  CLIENT@Example.COM "), "client@example.com");
    assert.equal(
      quoteSendFingerprint(sendFingerprintInput()),
      quoteSendFingerprint(sendFingerprintInput({ recipient: "client@example.com" })),
    );
    assert.match(
      quoteSendFingerprint(sendFingerprintInput()),
      /^quote-send:v1:sha256:[a-f0-9]{64}$/,
    );
  });

  it("changes the send fingerprint when recipient or revision fingerprint changes", () => {
    const base = sendFingerprintInput();

    assert.notEqual(
      quoteSendFingerprint(base),
      quoteSendFingerprint({ ...base, recipient: "other@example.com" }),
    );
    assert.notEqual(
      quoteSendFingerprint(base),
      quoteSendFingerprint({
        ...base,
        revisionFingerprint: "quote-revision:v1:sha256:different",
      }),
    );
  });

  it("rejects malformed recipient addresses", () => {
    for (const recipient of ["", "client", "client @example.com", "client@example"]) {
      assert.throws(() => normalizeQuoteRecipient(recipient), QuoteRecipientInvalidError);
    }
  });
});
