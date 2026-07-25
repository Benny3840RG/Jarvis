import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConvexQuoteRepository } from "../src/persistence/convexQuotes.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import {
  QuoteFinalizedImmutableError,
  QuoteFingerprintMismatchError,
  QuoteInvalidTransitionError,
  QuoteVersionConflictError,
} from "../src/quotes/quoteLifecycle.js";

const serviceToken = "owner-service-token";

function snapshotRow(
  overrides: {
    aggregate?: Partial<Record<string, unknown>>;
    revision?: Partial<Record<string, unknown>>;
  } = {},
) {
  return {
    aggregate: {
      _id: "aggregate-row-1",
      _creationTime: 1_700_000_000_001,
      ownerId: "owner-1",
      quoteId: "quote-1",
      clientId: "client-1",
      projectId: "project-1",
      number: "BT-2026-001",
      currentRevision: 2,
      currentRevisionId: "revision-row-2",
      aggregateVersion: 4,
      commercialStatus: "open",
      createdAt: 1_700_000_000_101,
      updatedAt: 1_700_000_000_202,
      ...overrides.aggregate,
    },
    revision: {
      _id: "revision-document-2",
      _creationTime: 1_700_000_000_002,
      ownerId: "owner-1",
      revisionId: "revision-row-2",
      quoteId: "quote-1",
      revision: 2,
      revisionVersion: 3,
      status: "draft",
      lineItems: [{ description: "Repair gate", quantity: 2, unitPrice: 125 }],
      subtotal: 250,
      taxRate: 0.1,
      tax: 25,
      total: 275,
      currency: "AUD",
      validUntil: "2026-08-31",
      notes: "Access through side gate",
      termsIncluded: true,
      createdAt: 1_700_000_000_303,
      updatedAt: 1_700_000_000_404,
      ...overrides.revision,
    },
  };
}

type RecordedCall = {
  kind: "query" | "mutation";
  args: unknown;
};

describe("ConvexQuoteRepository", () => {
  it("preserves exact authenticated Convex arguments for the quote lifecycle", async () => {
    const calls: RecordedCall[] = [];
    const client = {
      async query(_ref: unknown, args: unknown) {
        calls.push({ kind: "query", args });
        const values = args as Record<string, unknown>;
        if ("quoteId" in values) return snapshotRow();
        return [snapshotRow()];
      },
      async mutation(_ref: unknown, args: unknown) {
        calls.push({ kind: "mutation", args });
        return snapshotRow();
      },
    } as unknown as ConvexClientLike;
    const repository = new ConvexQuoteRepository({ client, serviceToken });

    const created = await repository.createQuote({
      clientId: "client-1",
      projectId: "project-1",
      number: "BT-2026-001",
      lineItems: [{ description: "Repair gate", quantity: 2, unitPrice: 125 }],
      taxRate: 0.1,
      validUntil: "2026-08-31",
      notes: "Access through side gate",
      termsIncluded: true,
      currency: "AUD",
    });
    const fetched = await repository.getQuote("quote-1");
    const listed = await repository.listQuotes({
      clientId: "client-1",
      projectId: "project-1",
      commercialStatus: "open",
      limit: 12,
    });
    const updated = await repository.updateDraft({
      quoteId: "quote-1",
      revision: 2,
      expectedAggregateVersion: 4,
      expectedRevisionVersion: 3,
      patch: {
        lineItems: [{ description: "Repair and brace gate", quantity: 2, unitPrice: 150 }],
        taxRate: null,
        validUntil: null,
        notes: "Client supplies paint",
        termsIncluded: false,
      },
    });
    await repository.submitForReview({
      quoteId: "quote-1",
      revision: 2,
      expectedAggregateVersion: 5,
      expectedRevisionVersion: 4,
    });
    await repository.reopenForEditing({
      quoteId: "quote-1",
      revision: 2,
      expectedAggregateVersion: 6,
      expectedRevisionVersion: 5,
    });
    await repository.finalizeRevision({
      quoteId: "quote-1",
      revision: 2,
      expectedAggregateVersion: 7,
      expectedRevisionVersion: 6,
    });
    await repository.createRevisionFromFinalized({
      quoteId: "quote-1",
      revision: 2,
      expectedAggregateVersion: 8,
      expectedRevisionVersion: 7,
      expectedFingerprint: "quote-revision:v1:sha256:abc123",
    });
    await repository.recordCommercialOutcome({
      quoteId: "quote-1",
      revision: 2,
      expectedAggregateVersion: 9,
      outcome: "accepted",
      recordedAt: 1_700_000_000_505,
    });

    assert.equal(created.aggregate.createdAt, 1_700_000_000_101);
    assert.equal(created.revision.updatedAt, 1_700_000_000_404);
    assert.equal(fetched?.aggregate.updatedAt, 1_700_000_000_202);
    assert.equal(updated.revision.revisionVersion, 3);
    assert.deepEqual(listed, [
      {
        quoteId: "quote-1",
        clientId: "client-1",
        projectId: "project-1",
        number: "BT-2026-001",
        currentRevision: 2,
        aggregateVersion: 4,
        revisionStatus: "draft",
        commercialStatus: "open",
        total: 275,
        currency: "AUD",
        updatedAt: 1_700_000_000_202,
      },
    ]);

    assert.deepEqual(
      calls.map(({ kind, args }) => ({ kind, args })),
      [
        {
          kind: "mutation",
          args: {
            serviceToken,
            clientId: "client-1",
            projectId: "project-1",
            number: "BT-2026-001",
            lineItems: [{ description: "Repair gate", quantity: 2, unitPrice: 125 }],
            taxRate: 0.1,
            validUntil: "2026-08-31",
            notes: "Access through side gate",
            termsIncluded: true,
          },
        },
        { kind: "query", args: { serviceToken, quoteId: "quote-1" } },
        {
          kind: "query",
          args: {
            serviceToken,
            clientId: "client-1",
            projectId: "project-1",
            commercialStatus: "open",
            limit: 12,
          },
        },
        {
          kind: "mutation",
          args: {
            serviceToken,
            quoteId: "quote-1",
            revision: 2,
            expectedAggregateVersion: 4,
            expectedRevisionVersion: 3,
            patch: {
              lineItems: [{ description: "Repair and brace gate", quantity: 2, unitPrice: 150 }],
              taxRate: null,
              validUntil: null,
              notes: "Client supplies paint",
              termsIncluded: false,
            },
          },
        },
        {
          kind: "mutation",
          args: {
            serviceToken,
            quoteId: "quote-1",
            revision: 2,
            expectedAggregateVersion: 5,
            expectedRevisionVersion: 4,
          },
        },
        {
          kind: "mutation",
          args: {
            serviceToken,
            quoteId: "quote-1",
            revision: 2,
            expectedAggregateVersion: 6,
            expectedRevisionVersion: 5,
          },
        },
        {
          kind: "mutation",
          args: {
            serviceToken,
            quoteId: "quote-1",
            revision: 2,
            expectedAggregateVersion: 7,
            expectedRevisionVersion: 6,
          },
        },
        {
          kind: "mutation",
          args: {
            serviceToken,
            quoteId: "quote-1",
            revision: 2,
            expectedAggregateVersion: 8,
            expectedRevisionVersion: 7,
            expectedFingerprint: "quote-revision:v1:sha256:abc123",
          },
        },
        {
          kind: "mutation",
          args: {
            serviceToken,
            quoteId: "quote-1",
            revision: 2,
            expectedAggregateVersion: 9,
            outcome: "accepted",
          },
        },
      ],
    );
  });

  it("preserves not-found nulls and restores typed quote-domain errors", async () => {
    const client = {
      async query() {
        return null;
      },
      async mutation() {
        throw new Error(
          "Uncaught QuoteVersionConflictError: Quote aggregate version does not match.",
        );
      },
    } as unknown as ConvexClientLike;
    const repository = new ConvexQuoteRepository({ client, serviceToken });

    assert.equal(await repository.getQuote("missing-quote"), null);
    await assert.rejects(
      repository.submitForReview({
        quoteId: "quote-1",
        revision: 2,
        expectedAggregateVersion: 4,
        expectedRevisionVersion: 3,
      }),
      QuoteVersionConflictError,
    );
  });

  it("maps known lifecycle errors and rethrows unknown failures unchanged", async () => {
    const cases = [
      ["QuoteInvalidTransitionError", QuoteInvalidTransitionError],
      ["QuoteFinalizedImmutableError", QuoteFinalizedImmutableError],
      ["QuoteFingerprintMismatchError", QuoteFingerprintMismatchError],
    ] as const;

    for (const [name, ErrorType] of cases) {
      const client = {
        async query() {
          return null;
        },
        async mutation() {
          throw new Error(`Server Error Uncaught ${name}: preserved message`);
        },
      } as unknown as ConvexClientLike;
      const repository = new ConvexQuoteRepository({ client, serviceToken });
      await assert.rejects(
        repository.finalizeRevision({
          quoteId: "quote-1",
          revision: 2,
          expectedAggregateVersion: 4,
          expectedRevisionVersion: 3,
        }),
        ErrorType,
      );
    }

    const outage = new Error("Convex transport closed unexpectedly");
    const client = {
      async query() {
        throw outage;
      },
      async mutation() {
        throw outage;
      },
    } as unknown as ConvexClientLike;
    const repository = new ConvexQuoteRepository({ client, serviceToken });
    await assert.rejects(repository.getQuote("quote-1"), (error: unknown) => error === outage);
  });

  it("requires an authenticated service token", () => {
    const client = {
      async query() {
        return null;
      },
      async mutation() {
        return snapshotRow();
      },
    } as unknown as ConvexClientLike;

    assert.throws(
      () => new ConvexQuoteRepository({ client, serviceToken: "" }),
      /require JARVIS_SERVICE_TOKEN/i,
    );
  });
});
