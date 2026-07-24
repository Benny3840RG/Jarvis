import assert from "node:assert/strict";
import { it } from "node:test";

import { ConvexQuoteRepository } from "../src/persistence/convexQuotes.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { quoteRevisionFingerprint } from "../src/quotes/quoteFingerprints.js";

const serviceToken = "owner-service-token";

type PersistedSnapshot = {
  aggregate: Record<string, unknown>;
  revision: Record<string, unknown>;
};

type PersistedStore = {
  snapshot: PersistedSnapshot | null;
  now: number;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function clientFor(store: PersistedStore): ConvexClientLike {
  return {
    async query(_ref: unknown, args: unknown) {
      const values = args as Record<string, unknown>;
      if ("quoteId" in values) return store.snapshot === null ? null : clone(store.snapshot);
      return store.snapshot === null ? [] : [clone(store.snapshot)];
    },
    async mutation(_ref: unknown, args: unknown) {
      const values = args as Record<string, unknown>;
      store.now += 1;

      if ("clientId" in values) {
        store.snapshot = {
          aggregate: {
            _id: "quote-row-1",
            _creationTime: store.now,
            ownerId: "owner-1",
            quoteId: "quote-1",
            clientId: values.clientId,
            projectId: values.projectId,
            number: values.number,
            currentRevision: 1,
            currentRevisionId: "revision-1",
            aggregateVersion: 1,
            commercialStatus: "open",
            createdAt: store.now,
            updatedAt: store.now,
          },
          revision: {
            _id: "revision-row-1",
            _creationTime: store.now,
            ownerId: "owner-1",
            revisionId: "revision-1",
            quoteId: "quote-1",
            revision: 1,
            revisionVersion: 1,
            status: "draft",
            lineItems: values.lineItems,
            subtotal: 200,
            taxRate: values.taxRate,
            tax: 20,
            total: 220,
            currency: "AUD",
            validUntil: values.validUntil,
            notes: values.notes,
            termsIncluded: values.termsIncluded,
            createdAt: store.now,
            updatedAt: store.now,
          },
        };
        return clone(store.snapshot);
      }

      if (store.snapshot === null) throw new Error("Quote not found.");
      const aggregate = store.snapshot.aggregate;
      const revision = store.snapshot.revision;
      assert.equal(values.expectedAggregateVersion, aggregate.aggregateVersion);
      assert.equal(values.expectedRevisionVersion, revision.revisionVersion);

      if (revision.status === "draft") {
        aggregate.aggregateVersion = Number(aggregate.aggregateVersion) + 1;
        aggregate.updatedAt = store.now;
        revision.status = "reviewed";
        revision.revisionVersion = Number(revision.revisionVersion) + 1;
        revision.reviewedAt = store.now;
        revision.updatedAt = store.now;
        return clone(store.snapshot);
      }

      if (revision.status === "reviewed") {
        const fingerprint = quoteRevisionFingerprint({
          ownerId: String(aggregate.ownerId),
          quoteId: String(aggregate.quoteId),
          revision: Number(revision.revision),
          clientId: String(aggregate.clientId),
          ...(aggregate.projectId === undefined ? {} : { projectId: String(aggregate.projectId) }),
          number: String(aggregate.number),
          lineItems: revision.lineItems as Array<{
            description: string;
            quantity: number;
            unitPrice: number;
          }>,
          subtotal: Number(revision.subtotal),
          ...(revision.taxRate === undefined ? {} : { taxRate: Number(revision.taxRate) }),
          tax: Number(revision.tax),
          total: Number(revision.total),
          currency: "AUD",
          ...(revision.validUntil === undefined
            ? {}
            : { validUntil: String(revision.validUntil) }),
          ...(revision.notes === undefined ? {} : { notes: String(revision.notes) }),
          termsIncluded: Boolean(revision.termsIncluded),
        });
        aggregate.aggregateVersion = Number(aggregate.aggregateVersion) + 1;
        aggregate.updatedAt = store.now;
        revision.status = "finalized";
        revision.revisionVersion = Number(revision.revisionVersion) + 1;
        revision.fingerprint = fingerprint;
        revision.finalizedAt = store.now;
        revision.updatedAt = store.now;
        return clone(store.snapshot);
      }

      throw new Error("Unexpected quote transition in persistence test.");
    },
  } as unknown as ConvexClientLike;
}

it("persists a finalized quote fingerprint across fresh adapter and client instances", async () => {
  const store: PersistedStore = { snapshot: null, now: 1_700_000_000_000 };
  const adapterA = new ConvexQuoteRepository({ client: clientFor(store), serviceToken });

  const created = await adapterA.createQuote({
    clientId: "client-1",
    projectId: "project-1",
    number: "BT-2026-001",
    lineItems: [{ description: "Labour", quantity: 2, unitPrice: 100 }],
    taxRate: 0.1,
    validUntil: "2026-08-24",
    notes: "Includes cleanup",
    termsIncluded: true,
  });

  const adapterB = new ConvexQuoteRepository({ client: clientFor(store), serviceToken });
  const fetched = await adapterB.getQuote(created.aggregate.quoteId);
  assert.equal(fetched?.revision.status, "draft");

  const reviewed = await adapterB.submitForReview({
    quoteId: created.aggregate.quoteId,
    revision: 1,
    expectedAggregateVersion: created.aggregate.aggregateVersion,
    expectedRevisionVersion: created.revision.revisionVersion,
  });
  const finalized = await adapterB.finalizeRevision({
    quoteId: created.aggregate.quoteId,
    revision: 1,
    expectedAggregateVersion: reviewed.aggregate.aggregateVersion,
    expectedRevisionVersion: reviewed.revision.revisionVersion,
  });

  const adapterC = new ConvexQuoteRepository({ client: clientFor(store), serviceToken });
  const persisted = await adapterC.getQuote(created.aggregate.quoteId);

  assert.match(finalized.revision.fingerprint ?? "", /^quote-revision:v1:sha256:[a-f0-9]{64}$/);
  assert.equal(persisted?.revision.status, "finalized");
  assert.equal(persisted?.revision.fingerprint, finalized.revision.fingerprint);
  assert.equal(persisted?.revision.total, 220);
});
