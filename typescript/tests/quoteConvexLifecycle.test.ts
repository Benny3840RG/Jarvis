import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyQuoteDraftPatch,
  buildInitialQuoteRecords,
  finalizeQuoteRevision,
  forkFinalizedQuote,
  recordQuoteCommercialOutcome,
  transitionQuoteRevision,
} from "../convex/quoteValidators.js";
import {
  QuoteFinalizedImmutableError,
  QuoteInvalidTransitionError,
  QuoteVersionConflictError,
} from "../src/quotes/quoteLifecycle.js";

const NOW = 1_785_000_000_000;

function initial() {
  return buildInitialQuoteRecords({
    ownerId: "owner-1",
    quoteId: "quote-1",
    revisionId: "revision-1",
    clientId: "client-1",
    projectId: "project-1",
    number: "BT-2026-001",
    lineItems: [{ description: "Labour", quantity: 2, unitPrice: 100 }],
    taxRate: 0.1,
    validUntil: "2026-08-24",
    notes: "Includes cleanup",
    termsIncluded: true,
    now: NOW,
  });
}

describe("quote Convex lifecycle logic", () => {
  it("creates aggregate and revision 1 with server-derived totals", () => {
    const result = initial();

    assert.equal(result.aggregate.currentRevision, 1);
    assert.equal(result.aggregate.currentRevisionId, "revision-1");
    assert.equal(result.aggregate.aggregateVersion, 1);
    assert.equal(result.aggregate.commercialStatus, "open");
    assert.equal(result.revision.status, "draft");
    assert.equal(result.revision.revisionVersion, 1);
    assert.equal(result.revision.subtotal, 200);
    assert.equal(result.revision.tax, 20);
    assert.equal(result.revision.total, 220);
  });

  it("rejects stale aggregate and revision versions", () => {
    const { aggregate, revision } = initial();

    assert.throws(
      () =>
        applyQuoteDraftPatch({
          aggregate,
          revision,
          expectedAggregateVersion: 0,
          expectedRevisionVersion: 1,
          patch: { notes: "changed" },
          now: NOW + 1,
        }),
      QuoteVersionConflictError,
    );
    assert.throws(
      () =>
        applyQuoteDraftPatch({
          aggregate,
          revision,
          expectedAggregateVersion: 1,
          expectedRevisionVersion: 0,
          patch: { notes: "changed" },
          now: NOW + 1,
        }),
      QuoteVersionConflictError,
    );
  });

  it("allows draft review, review reopen, and reviewed finalization only", async () => {
    const created = initial();
    const reviewed = transitionQuoteRevision({
      aggregate: created.aggregate,
      revision: created.revision,
      expectedAggregateVersion: 1,
      expectedRevisionVersion: 1,
      to: "reviewed",
      now: NOW + 1,
    });

    assert.equal(reviewed.revision.status, "reviewed");
    assert.equal(reviewed.revision.reviewedAt, NOW + 1);
    assert.equal(reviewed.revision.revisionVersion, 2);

    const finalized = await finalizeQuoteRevision({
      aggregate: reviewed.aggregate,
      revision: reviewed.revision,
      expectedAggregateVersion: 2,
      expectedRevisionVersion: 2,
      now: NOW + 2,
    });
    assert.equal(finalized.revision.status, "finalized");
    assert.equal(finalized.revision.finalizedAt, NOW + 2);
    assert.match(finalized.revision.fingerprint ?? "", /^quote-revision:v1:sha256:[a-f0-9]{64}$/);

    assert.throws(
      () =>
        transitionQuoteRevision({
          aggregate: created.aggregate,
          revision: created.revision,
          expectedAggregateVersion: 1,
          expectedRevisionVersion: 1,
          to: "finalized",
          now: NOW + 1,
        }),
      QuoteInvalidTransitionError,
    );
  });

  it("keeps finalized revisions immutable", async () => {
    const created = initial();
    const reviewed = transitionQuoteRevision({
      aggregate: created.aggregate,
      revision: created.revision,
      expectedAggregateVersion: 1,
      expectedRevisionVersion: 1,
      to: "reviewed",
      now: NOW + 1,
    });
    const finalized = await finalizeQuoteRevision({
      aggregate: reviewed.aggregate,
      revision: reviewed.revision,
      expectedAggregateVersion: 2,
      expectedRevisionVersion: 2,
      now: NOW + 2,
    });

    assert.throws(
      () =>
        applyQuoteDraftPatch({
          aggregate: finalized.aggregate,
          revision: finalized.revision,
          expectedAggregateVersion: 3,
          expectedRevisionVersion: 3,
          patch: { notes: "changed" },
          now: NOW + 3,
        }),
      QuoteFinalizedImmutableError,
    );
  });

  it("forks one new draft revision and rejects a stale second fork", async () => {
    const created = initial();
    const reviewed = transitionQuoteRevision({
      aggregate: created.aggregate,
      revision: created.revision,
      expectedAggregateVersion: 1,
      expectedRevisionVersion: 1,
      to: "reviewed",
      now: NOW + 1,
    });
    const finalized = await finalizeQuoteRevision({
      aggregate: reviewed.aggregate,
      revision: reviewed.revision,
      expectedAggregateVersion: 2,
      expectedRevisionVersion: 2,
      now: NOW + 2,
    });
    const firstFork = forkFinalizedQuote({
      aggregate: finalized.aggregate,
      revision: finalized.revision,
      expectedAggregateVersion: 3,
      expectedRevisionVersion: 3,
      expectedFingerprint: finalized.revision.fingerprint ?? "",
      newRevisionId: "revision-2",
      now: NOW + 3,
    });

    assert.equal(firstFork.aggregate.currentRevision, 2);
    assert.equal(firstFork.aggregate.currentRevisionId, "revision-2");
    assert.equal(firstFork.aggregate.commercialStatus, "open");
    assert.equal(firstFork.revision.revision, 2);
    assert.equal(firstFork.revision.status, "draft");
    assert.equal(firstFork.revision.fingerprint, undefined);
    assert.equal(firstFork.revision.predecessorRevisionId, "revision-1");

    assert.throws(
      () =>
        forkFinalizedQuote({
          aggregate: firstFork.aggregate,
          revision: finalized.revision,
          expectedAggregateVersion: 3,
          expectedRevisionVersion: 3,
          expectedFingerprint: finalized.revision.fingerprint ?? "",
          newRevisionId: "revision-3",
          now: NOW + 4,
        }),
      QuoteVersionConflictError,
    );
  });

  it("stores historical acceptance on the exact finalized revision", async () => {
    const created = initial();
    const reviewed = transitionQuoteRevision({
      aggregate: created.aggregate,
      revision: created.revision,
      expectedAggregateVersion: 1,
      expectedRevisionVersion: 1,
      to: "reviewed",
      now: NOW + 1,
    });
    const finalized = await finalizeQuoteRevision({
      aggregate: reviewed.aggregate,
      revision: reviewed.revision,
      expectedAggregateVersion: 2,
      expectedRevisionVersion: 2,
      now: NOW + 2,
    });
    const accepted = recordQuoteCommercialOutcome({
      aggregate: finalized.aggregate,
      revision: finalized.revision,
      expectedAggregateVersion: 3,
      outcome: "accepted",
      now: NOW + 3,
    });

    assert.equal(accepted.aggregate.commercialStatus, "accepted");
    assert.equal(accepted.aggregate.commercialRevision, 1);
    assert.equal(accepted.revision.historicalOutcome, "accepted");
    assert.equal(accepted.revision.historicalOutcomeRecordedAt, NOW + 3);
  });
});
