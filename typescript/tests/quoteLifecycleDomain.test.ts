import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyDraftPatch,
  assertRevisionTransition,
  computeQuoteTotals,
  QuoteFinalizedImmutableError,
  QuoteInvalidTransitionError,
  type QuoteRevision,
  QuoteVersionConflictError,
} from "../src/quotes/quoteLifecycle.js";

function revisionFixture(overrides: Partial<QuoteRevision> = {}): QuoteRevision {
  return {
    revisionId: "revision-1",
    ownerId: "owner-1",
    quoteId: "quote-1",
    revision: 1,
    revisionVersion: 1,
    status: "draft",
    lineItems: [{ description: "Labour", quantity: 2, unitPrice: 100 }],
    subtotal: 200,
    taxRate: 0.1,
    tax: 20,
    total: 220,
    currency: "AUD",
    termsIncluded: true,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("quote lifecycle domain", () => {
  it("allows draft -> reviewed -> finalized and rejects draft -> finalized", () => {
    assert.doesNotThrow(() => assertRevisionTransition("draft", "reviewed"));
    assert.doesNotThrow(() => assertRevisionTransition("reviewed", "draft"));
    assert.doesNotThrow(() => assertRevisionTransition("reviewed", "finalized"));
    assert.throws(
      () => assertRevisionTransition("draft", "finalized"),
      QuoteInvalidTransitionError,
    );
  });

  it("refuses content mutation on finalized revisions", () => {
    const revision = revisionFixture({
      status: "finalized",
      fingerprint: "quote-revision:v1:sha256:finalized",
      finalizedAt: 1_100,
    });

    assert.throws(
      () => applyDraftPatch(revision, { notes: "changed" }, revision.revisionVersion),
      QuoteFinalizedImmutableError,
    );
  });

  it("rejects a stale draft revision version", () => {
    const revision = revisionFixture({ revisionVersion: 3 });

    assert.throws(
      () => applyDraftPatch(revision, { notes: "changed" }, 2),
      QuoteVersionConflictError,
    );
  });

  it("patches a draft immutably, increments its version, and re-derives totals", () => {
    const revision = revisionFixture();
    const patched = applyDraftPatch(
      revision,
      {
        lineItems: [
          { description: "Labour", quantity: 3, unitPrice: 80 },
          { description: "Materials", quantity: 1, unitPrice: 60 },
        ],
        notes: "Revised scope",
      },
      1,
      2_000,
    );

    assert.notEqual(patched, revision);
    assert.deepEqual(revision.lineItems, [{ description: "Labour", quantity: 2, unitPrice: 100 }]);
    assert.equal(revision.notes, undefined);
    assert.equal(patched.revisionVersion, 2);
    assert.equal(patched.subtotal, 300);
    assert.equal(patched.tax, 30);
    assert.equal(patched.total, 330);
    assert.equal(patched.notes, "Revised scope");
    assert.equal(patched.updatedAt, 2_000);
  });

  it("derives currency totals to cents", () => {
    assert.deepEqual(
      computeQuoteTotals(
        [
          { description: "Labour", quantity: 1.5, unitPrice: 99.99 },
          { description: "Materials", quantity: 2, unitPrice: 10.005 },
        ],
        0.1,
      ),
      { subtotal: 170, tax: 17, total: 187 },
    );
  });
});
