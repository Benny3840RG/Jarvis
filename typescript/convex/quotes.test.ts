import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "quote-test-service-token-0000000000000000";

function harness() {
  return convexTest(schema, modules);
}

function createInput(number = "BT-2026-001") {
  return {
    serviceToken: SERVICE_TOKEN,
    clientId: "client-1",
    projectId: "project-1",
    number,
    lineItems: [{ description: "Labour", quantity: 2, unitPrice: 100 }],
    taxRate: 0.1,
    validUntil: "2026-08-24",
    notes: "Includes cleanup",
    termsIncluded: true,
  };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("persisted quote Convex lifecycle", () => {
  it("creates, reads, reviews, finalizes, and persists the exact fingerprint", async () => {
    const t = harness();
    const created = await t.mutation(api.quotes.create, createInput());

    expect(created.aggregate).toMatchObject({
      ownerId: "jarvis-cli",
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
    });

    const rowCounts = await t.run(async (ctx) => ({
      quotes: (await ctx.db.query("quotes").collect()).length,
      revisions: (await ctx.db.query("quoteRevisions").collect()).length,
    }));
    expect(rowCounts).toEqual({ quotes: 1, revisions: 1 });

    const fetched = await t.query(api.quotes.get, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
    });
    expect(fetched?.aggregate.quoteId).toBe(created.aggregate.quoteId);
    expect(fetched?.revision.revisionId).toBe(created.revision.revisionId);

    const reviewed = await t.mutation(api.quotes.submitForReview, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: 1,
      expectedRevisionVersion: 1,
    });
    expect(reviewed.revision.status).toBe("reviewed");

    const finalized = await t.mutation(api.quotes.finalizeRevision, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: reviewed.aggregate.aggregateVersion,
      expectedRevisionVersion: reviewed.revision.revisionVersion,
    });
    expect(finalized.revision.status).toBe("finalized");
    expect(finalized.revision.fingerprint).toMatch(/^quote-revision:v1:sha256:[a-f0-9]{64}$/);

    const persisted = await t.query(api.quotes.get, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
    });
    expect(persisted?.revision.fingerprint).toBe(finalized.revision.fingerprint);
    expect(persisted?.revision.total).toBe(220);
  });

  it("rejects stale writes and permits exactly one concurrent fork", async () => {
    const t = harness();
    const created = await t.mutation(api.quotes.create, createInput());

    await expect(
      t.mutation(api.quotes.updateDraft, {
        serviceToken: SERVICE_TOKEN,
        quoteId: created.aggregate.quoteId,
        revision: 1,
        expectedAggregateVersion: 0,
        expectedRevisionVersion: 1,
        patch: { notes: "stale" },
      }),
    ).rejects.toThrow(/version/i);

    const reviewed = await t.mutation(api.quotes.submitForReview, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: 1,
      expectedRevisionVersion: 1,
    });
    const finalized = await t.mutation(api.quotes.finalizeRevision, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: reviewed.aggregate.aggregateVersion,
      expectedRevisionVersion: reviewed.revision.revisionVersion,
    });

    const forkArgs = {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: finalized.aggregate.aggregateVersion,
      expectedRevisionVersion: finalized.revision.revisionVersion,
      expectedFingerprint: finalized.revision.fingerprint ?? "",
    };
    const results = await Promise.allSettled([
      t.mutation(api.quotes.forkRevision, forkArgs),
      t.mutation(api.quotes.forkRevision, forkArgs),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const persisted = await t.query(api.quotes.get, {
      serviceToken: SERVICE_TOKEN,
      quoteId: created.aggregate.quoteId,
    });
    expect(persisted?.aggregate.currentRevision).toBe(2);
    expect(persisted?.revision.status).toBe("draft");

    const revisionCount = await t.run(
      async (ctx) => (await ctx.db.query("quoteRevisions").collect()).length,
    );
    expect(revisionCount).toBe(2);
  });

  it("returns identical external behavior for absent and cross-owner records", async () => {
    const t = harness();
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("quotes", {
        ownerId: "other-owner",
        quoteId: "other-quote",
        clientId: "other-client",
        number: "OTHER-001",
        currentRevision: 1,
        currentRevisionId: "other-revision",
        aggregateVersion: 1,
        commercialStatus: "open",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("quoteRevisions", {
        ownerId: "other-owner",
        revisionId: "other-revision",
        quoteId: "other-quote",
        revision: 1,
        revisionVersion: 1,
        status: "draft",
        lineItems: [],
        subtotal: 0,
        tax: 0,
        total: 0,
        currency: "AUD",
        termsIncluded: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    const absent = await t.query(api.quotes.get, {
      serviceToken: SERVICE_TOKEN,
      quoteId: "missing-quote",
    });
    const crossOwner = await t.query(api.quotes.get, {
      serviceToken: SERVICE_TOKEN,
      quoteId: "other-quote",
    });
    expect(absent).toBeNull();
    expect(crossOwner).toBeNull();

    const mutationArgs = {
      serviceToken: SERVICE_TOKEN,
      revision: 1,
      expectedAggregateVersion: 1,
      expectedRevisionVersion: 1,
      patch: { notes: "must not leak" },
    };
    await expect(
      t.mutation(api.quotes.updateDraft, { ...mutationArgs, quoteId: "missing-quote" }),
    ).rejects.toThrow("Quote not found.");
    await expect(
      t.mutation(api.quotes.updateDraft, { ...mutationArgs, quoteId: "other-quote" }),
    ).rejects.toThrow("Quote not found.");
  });

  it("rolls back duplicate-number creation without a partial revision", async () => {
    const t = harness();
    await t.mutation(api.quotes.create, createInput());

    await expect(t.mutation(api.quotes.create, createInput())).rejects.toThrow(/already exists/i);

    const rowCounts = await t.run(async (ctx) => ({
      quotes: (await ctx.db.query("quotes").collect()).length,
      revisions: (await ctx.db.query("quoteRevisions").collect()).length,
    }));
    expect(rowCounts).toEqual({ quotes: 1, revisions: 1 });
  });
});
