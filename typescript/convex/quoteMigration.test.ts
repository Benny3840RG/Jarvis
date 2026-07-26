import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "quote-migration-test-service-token-0000000";
const DEPLOYMENT = "dev:outgoing-ram-798";

function harness() {
  return convexTest(schema, modules);
}

function importInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    serviceToken: SERVICE_TOKEN,
    deployment: DEPLOYMENT,
    sourceKey: "legacy-quote:1",
    clientId: "client-1",
    number: "Q-LEGACY-1",
    status: "draft" as const,
    lineItems: [{ description: "Fence panel", quantity: 2, unitPrice: 150 }],
    termsIncluded: true,
    legacyCreatedAt: 1000,
    legacyUpdatedAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("legacy quote migration", () => {
  it("refuses outside the authorised development deployment", async () => {
    const t = harness();
    await expect(
      t.mutation(api.quoteMigration.importLegacyQuote, importInput({ deployment: "dev:other" })),
    ).rejects.toThrow(/authorised development deployment/);
    await expect(
      t.mutation(api.quoteMigration.importLegacyQuote, importInput({ deployment: "prod:main" })),
    ).rejects.toThrow(/authorised development deployment/);
  });

  it("maps draft -> revision draft, aggregate open", async () => {
    const t = harness();
    const result = await t.mutation(api.quoteMigration.importLegacyQuote, importInput());
    expect(result.status).toBe("imported");
    expect(result.mappedState).toBe("draft");

    const persisted = await t.query(api.quotes.get, {
      serviceToken: SERVICE_TOKEN,
      quoteId: result.quoteId!,
    });
    expect(persisted?.aggregate.commercialStatus).toBe("open");
    expect(persisted?.revision.status).toBe("draft");
    expect(persisted?.revision.fingerprint).toBeUndefined();
  });

  it("maps sent -> migration-imported finalized revision, aggregate open, no delivery attempt", async () => {
    const t = harness();
    const result = await t.mutation(
      api.quoteMigration.importLegacyQuote,
      importInput({ sourceKey: "legacy-quote:2", number: "Q-LEGACY-2", status: "sent" }),
    );
    expect(result.mappedState).toBe("finalized:open");

    const persisted = await t.query(api.quotes.get, {
      serviceToken: SERVICE_TOKEN,
      quoteId: result.quoteId!,
    });
    expect(persisted?.revision.status).toBe("finalized");
    expect(persisted?.revision.source).toBe("legacy-migration");
    expect(persisted?.revision.fingerprint).toMatch(/^quote-revision:v1:sha256:[a-f0-9]{64}$/);
    expect(persisted?.aggregate.commercialStatus).toBe("open");
    expect(persisted?.revision.historicalOutcome).toBeUndefined();

    const deliveries = await t.run(
      async (ctx) => (await ctx.db.query("quoteDeliveryAttempts").collect()).length,
    );
    expect(deliveries).toBe(0);
  });

  it.each(["accepted", "declined"] as const)(
    "maps %s -> migration-imported finalized revision, historical + aggregate outcome",
    async (status) => {
      const t = harness();
      const result = await t.mutation(
        api.quoteMigration.importLegacyQuote,
        importInput({ sourceKey: `legacy-quote:${status}`, number: `Q-LEGACY-${status}`, status }),
      );
      expect(result.mappedState).toBe(`finalized:${status}`);

      const persisted = await t.query(api.quotes.get, {
        serviceToken: SERVICE_TOKEN,
        quoteId: result.quoteId!,
      });
      expect(persisted?.revision.status).toBe("finalized");
      expect(persisted?.revision.source).toBe("legacy-migration");
      expect(persisted?.revision.historicalOutcome).toBe(status);
      expect(persisted?.aggregate.commercialStatus).toBe(status);
      expect(persisted?.aggregate.commercialRevision).toBe(1);
    },
  );

  it("recomputes totals from line items rather than trusting any caller-supplied total", async () => {
    const t = harness();
    const result = await t.mutation(
      api.quoteMigration.importLegacyQuote,
      importInput({
        lineItems: [{ description: "Panel", quantity: 3, unitPrice: 100 }],
        taxRate: 0.1,
      }),
    );
    const persisted = await t.query(api.quotes.get, {
      serviceToken: SERVICE_TOKEN,
      quoteId: result.quoteId!,
    });
    expect(persisted?.revision.subtotal).toBe(300);
    expect(persisted?.revision.tax).toBe(30);
    expect(persisted?.revision.total).toBe(330);
  });

  it("replays the exact same result for a repeated source key without creating a second quote", async () => {
    const t = harness();
    const first = await t.mutation(api.quoteMigration.importLegacyQuote, importInput());
    const second = await t.mutation(api.quoteMigration.importLegacyQuote, importInput());

    expect(second.quoteId).toBe(first.quoteId);
    expect(second.revisionId).toBe(first.revisionId);

    const rowCounts = await t.run(async (ctx) => ({
      quotes: (await ctx.db.query("quotes").collect()).length,
      migrationRecords: (await ctx.db.query("quoteMigrationRecords").collect()).length,
    }));
    expect(rowCounts).toEqual({ quotes: 1, migrationRecords: 1 });
  });

  it("rejects and reports a row with no line items without throwing", async () => {
    const t = harness();
    const result = await t.mutation(
      api.quoteMigration.importLegacyQuote,
      importInput({ lineItems: [] }),
    );
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(/no line items/i);

    const rowCounts = await t.run(async (ctx) => ({
      quotes: (await ctx.db.query("quotes").collect()).length,
      migrationRecords: (await ctx.db.query("quoteMigrationRecords").collect()).length,
    }));
    expect(rowCounts).toEqual({ quotes: 0, migrationRecords: 1 });
  });

  it("rejects a colliding quote number for a different source key and replays the rejection on retry", async () => {
    const t = harness();
    await t.mutation(api.quoteMigration.importLegacyQuote, importInput());

    const collision = await t.mutation(
      api.quoteMigration.importLegacyQuote,
      importInput({ sourceKey: "legacy-quote:collides" }),
    );
    expect(collision.status).toBe("rejected");
    expect(collision.rejectionReason).toMatch(/already exists/i);

    const replay = await t.mutation(
      api.quoteMigration.importLegacyQuote,
      importInput({ sourceKey: "legacy-quote:collides" }),
    );
    expect(replay).toEqual(collision);
  });
});
