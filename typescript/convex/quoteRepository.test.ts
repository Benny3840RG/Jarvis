import type { ConvexHttpClient } from "convex/browser";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { ConvexQuoteRepository } from "../src/quotes/convexQuoteRepository.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";

const SERVICE_TOKEN = "quote-repo-test-service-token-00000000000";

type Harness = ReturnType<typeof convexTest>;

function clientFor(
  t: Harness,
): ConvexClientLike & Pick<ConvexHttpClient, "action"> {
  return {
    query: (reference: unknown, args?: Record<string, unknown>) =>
      (t as { query: (r: unknown, a?: unknown) => Promise<unknown> }).query(reference, args),
    mutation: (reference: unknown, args?: Record<string, unknown>) =>
      (t as { mutation: (r: unknown, a?: unknown) => Promise<unknown> }).mutation(reference, args),
    action: (reference: unknown, args?: Record<string, unknown>) =>
      (t as { action: (r: unknown, a?: unknown) => Promise<unknown> }).action(reference, args),
  } as unknown as ConvexClientLike & Pick<ConvexHttpClient, "action">;
}

const finalizationPresentation = {
  issuer: { name: "Benny's Trade Services", email: "quotes@example.com" },
  client: { name: "Example Client", email: "client@example.com" },
};

function createInput(number = "BT-2026-001") {
  return {
    clientId: "client-1",
    projectId: "project-1",
    number,
    lineItems: [{ description: "Labour", quantity: 2, unitPrice: 100 }],
    taxRate: 0.1,
    validUntil: "2026-08-24",
    notes: "Includes cleanup",
    termsIncluded: true as const,
  };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ConvexQuoteRepository against persisted Convex functions", () => {
  it("requires a service token", () => {
    const t = convexTest(schema, modules);
    expect(() => new ConvexQuoteRepository(clientFor(t), "")).toThrow(
      /requires JARVIS_SERVICE_TOKEN/,
    );
  });

  it("creates a quote and reads it back through a fresh repository instance (restart persistence)", async () => {
    const t = convexTest(schema, modules);
    const created = await new ConvexQuoteRepository(clientFor(t), SERVICE_TOKEN).createQuote(
      createInput(),
    );

    expect(created.aggregate).toMatchObject({
      ownerId: "jarvis-cli",
      clientId: "client-1",
      currentRevision: 1,
      aggregateVersion: 1,
      commercialStatus: "open",
    });
    expect(created.revision).toMatchObject({
      revision: 1,
      revisionVersion: 1,
      status: "draft",
      subtotal: 200,
      tax: 20,
      total: 220,
      currency: "AUD",
    });
    // Convex bookkeeping fields must not leak into the domain snapshot.
    expect(created.aggregate).not.toHaveProperty("_id");
    expect(created.revision).not.toHaveProperty("_creationTime");

    // A brand-new repository instance over the same backend must observe the
    // persisted quote — the store survives a repository "restart".
    const reopened = await new ConvexQuoteRepository(clientFor(t), SERVICE_TOKEN).getQuote(
      created.aggregate.quoteId,
    );
    expect(reopened?.aggregate.quoteId).toBe(created.aggregate.quoteId);
    expect(reopened?.revision.revisionId).toBe(created.revision.revisionId);
    expect(reopened?.revision.total).toBe(220);

    expect(await new ConvexQuoteRepository(clientFor(t), SERVICE_TOKEN).getQuote("missing")).toBe(
      null,
    );
  });

  it("drives the full draft → review → finalize → fork lifecycle and lists summaries", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteRepository(clientFor(t), SERVICE_TOKEN);
    const created = await repo.createQuote(createInput());
    const { quoteId } = created.aggregate;

    const patched = await repo.updateDraft({
      quoteId,
      revision: 1,
      expectedAggregateVersion: created.aggregate.aggregateVersion,
      expectedRevisionVersion: created.revision.revisionVersion,
      patch: { notes: "Revised scope" },
    });
    expect(patched.revision.notes).toBe("Revised scope");

    const reviewed = await repo.submitForReview({
      quoteId,
      revision: 1,
      expectedAggregateVersion: patched.aggregate.aggregateVersion,
      expectedRevisionVersion: patched.revision.revisionVersion,
    });
    expect(reviewed.revision.status).toBe("reviewed");

    const finalized = await repo.finalizeRevision({
      quoteId,
      revision: 1,
      expectedAggregateVersion: reviewed.aggregate.aggregateVersion,
      expectedRevisionVersion: reviewed.revision.revisionVersion,
      ...finalizationPresentation,
    });
    expect(finalized.revision.status).toBe("finalized");
    expect(finalized.revision.fingerprint).toMatch(/^quote-revision:v1:sha256:[a-f0-9]{64}$/);

    const forked = await repo.createRevisionFromFinalized({
      quoteId,
      revision: 1,
      expectedAggregateVersion: finalized.aggregate.aggregateVersion,
      expectedRevisionVersion: finalized.revision.revisionVersion,
      expectedFingerprint: finalized.revision.fingerprint ?? "",
    });
    expect(forked.aggregate.currentRevision).toBe(2);
    expect(forked.revision.status).toBe("draft");
    expect(forked.revision.fingerprint).toBeUndefined();
    expect(forked.revision.predecessorRevisionId).toBe(finalized.revision.revisionId);

    const summaries = await repo.listQuotes({});
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      quoteId,
      number: "BT-2026-001",
      currentRevision: 2,
      revisionStatus: "draft",
      commercialStatus: "open",
      currency: "AUD",
    });
  });

  it("reopens a reviewed revision and records a commercial outcome", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteRepository(clientFor(t), SERVICE_TOKEN);
    const created = await repo.createQuote(createInput());
    const { quoteId } = created.aggregate;

    const reviewed = await repo.submitForReview({
      quoteId,
      revision: 1,
      expectedAggregateVersion: created.aggregate.aggregateVersion,
      expectedRevisionVersion: created.revision.revisionVersion,
    });
    const reopened = await repo.reopenForEditing({
      quoteId,
      revision: 1,
      expectedAggregateVersion: reviewed.aggregate.aggregateVersion,
      expectedRevisionVersion: reviewed.revision.revisionVersion,
    });
    expect(reopened.revision.status).toBe("draft");

    const rereviewed = await repo.submitForReview({
      quoteId,
      revision: 1,
      expectedAggregateVersion: reopened.aggregate.aggregateVersion,
      expectedRevisionVersion: reopened.revision.revisionVersion,
    });
    const finalized = await repo.finalizeRevision({
      quoteId,
      revision: 1,
      expectedAggregateVersion: rereviewed.aggregate.aggregateVersion,
      expectedRevisionVersion: rereviewed.revision.revisionVersion,
      ...finalizationPresentation,
    });

    const accepted = await repo.recordCommercialOutcome({
      quoteId,
      revision: 1,
      expectedAggregateVersion: finalized.aggregate.aggregateVersion,
      outcome: "accepted",
    });
    expect(accepted.aggregate.commercialStatus).toBe("accepted");
    expect(accepted.aggregate.commercialRevision).toBe(1);
    expect(accepted.revision.historicalOutcome).toBe("accepted");
  });

  it("threads the constructor's deployment through to cleanup, restricted to the authorised development deployment", async () => {
    const t = convexTest(schema, modules);
    const client = clientFor(t);
    const created = await new ConvexQuoteRepository(client, SERVICE_TOKEN).createQuote(
      createInput(),
    );
    const { quoteId } = created.aggregate;

    await expect(
      new ConvexQuoteRepository(client, SERVICE_TOKEN, "prod:jarvis").cleanup(quoteId),
    ).rejects.toThrow(/authorised development deployment/);

    const removed = await new ConvexQuoteRepository(
      client,
      SERVICE_TOKEN,
      "dev:outgoing-ram-798",
    ).cleanup(quoteId);
    expect(removed).toBe(true);
    expect(await new ConvexQuoteRepository(client, SERVICE_TOKEN).getQuote(quoteId)).toBe(null);
  });
});
