import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  legacySourceKey,
  mapLegacyQuote,
  migrateLegacyQuotes,
  type ImportLegacyQuoteFn,
  type LegacyQuoteImportInput,
  type LegacyQuoteImportResult,
} from "../src/tools/migrateLegacyQuotes.js";
import type { Quote, QuoteStore } from "../src/quotes/quote.js";

const DEPLOYMENT = "dev:outgoing-ram-798";
const SERVICE_TOKEN = "quote-migration-test-service-token";

function legacyQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: "legacy-1",
    clientId: "client-1",
    number: "Q-LEGACY-1",
    status: "draft",
    lineItems: [{ description: "Fence panel", quantity: 2, unitPrice: 150 }],
    subtotal: 300,
    tax: 0,
    total: 300,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function legacyStore(quotes: Quote[]): QuoteStore {
  return {
    async list() {
      return quotes;
    },
    async get() {
      throw new Error("get is not used in this test");
    },
    async add() {
      throw new Error("add is not used in this test");
    },
    async update() {
      throw new Error("update is not used in this test");
    },
    async remove() {
      throw new Error("remove is not used in this test");
    },
  };
}

/** In-memory double of the Convex mutation, mirroring its idempotent-replay/rejection semantics. */
function inMemoryImporter(): { fn: ImportLegacyQuoteFn; calls: LegacyQuoteImportInput[] } {
  const bySourceKey = new Map<string, LegacyQuoteImportResult>();
  const bySeenNumber = new Set<string>();
  const calls: LegacyQuoteImportInput[] = [];
  let nextId = 1;

  const fn: ImportLegacyQuoteFn = async (input) => {
    calls.push(input);
    const existing = bySourceKey.get(input.sourceKey);
    if (existing) return existing;

    let result: LegacyQuoteImportResult;
    if (input.lineItems.length === 0) {
      result = { sourceKey: input.sourceKey, status: "rejected", rejectionReason: "no line items" };
    } else if (bySeenNumber.has(input.number)) {
      result = {
        sourceKey: input.sourceKey,
        status: "rejected",
        rejectionReason: `Quote number "${input.number}" already exists for this owner.`,
      };
    } else {
      bySeenNumber.add(input.number);
      const mappedState =
        input.status === "draft"
          ? "draft"
          : input.status === "sent"
            ? "finalized:open"
            : `finalized:${input.status}`;
      result = {
        sourceKey: input.sourceKey,
        status: "imported",
        quoteId: `quote-${nextId}`,
        revisionId: `revision-${nextId}`,
        mappedState,
      };
      nextId += 1;
    }
    bySourceKey.set(input.sourceKey, result);
    return result;
  };

  return { fn, calls };
}

describe("legacy quote migration mapping", () => {
  it("derives a stable source key from the legacy record's own ID", () => {
    assert.equal(legacySourceKey(legacyQuote({ id: "abc" })), "legacy-quote:abc");
  });

  for (const [legacyStatus, expectedMappedState] of [
    ["draft", "draft"],
    ["sent", "finalized:open"],
    ["accepted", "finalized:accepted"],
    ["declined", "finalized:declined"],
  ] as const) {
    it(`maps legacy status "${legacyStatus}" to ${expectedMappedState}`, async () => {
      const { fn } = inMemoryImporter();
      const input = mapLegacyQuote(
        legacyQuote({ status: legacyStatus }),
        SERVICE_TOKEN,
        DEPLOYMENT,
      );
      const result = await fn(input);
      assert.equal(result.status, "imported");
      assert.equal(result.mappedState, expectedMappedState);
    });
  }

  it("maps optional legacy fields through without inventing values", () => {
    const input = mapLegacyQuote(
      legacyQuote({
        projectId: "project-1",
        taxRate: 0.1,
        validUntil: "2026-12-31",
        notes: "call ahead",
      }),
      SERVICE_TOKEN,
      DEPLOYMENT,
    );
    assert.equal(input.projectId, "project-1");
    assert.equal(input.taxRate, 0.1);
    assert.equal(input.validUntil, "2026-12-31");
    assert.equal(input.notes, "call ahead");
  });
});

describe("migrateLegacyQuotes orchestration", () => {
  it("refuses outside a dev: deployment without calling the importer", async () => {
    const { fn, calls } = inMemoryImporter();
    await assert.rejects(
      migrateLegacyQuotes(legacyStore([legacyQuote()]), fn, SERVICE_TOKEN, "prod:something"),
      /dev:/,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses with no deployment configured at all", async () => {
    const { fn, calls } = inMemoryImporter();
    await assert.rejects(
      migrateLegacyQuotes(legacyStore([legacyQuote()]), fn, SERVICE_TOKEN, undefined),
      /dev:/,
    );
    assert.equal(calls.length, 0);
  });

  it("imports every legacy quote and summarizes the outcome", async () => {
    const { fn } = inMemoryImporter();
    const quotes = [
      legacyQuote({ id: "q1", number: "Q-1", status: "draft" }),
      legacyQuote({ id: "q2", number: "Q-2", status: "sent" }),
      legacyQuote({ id: "q3", number: "Q-3", status: "accepted" }),
      legacyQuote({ id: "q4", number: "Q-4", status: "declined" }),
    ];
    const summary = await migrateLegacyQuotes(legacyStore(quotes), fn, SERVICE_TOKEN, DEPLOYMENT);

    assert.equal(summary.total, 4);
    assert.equal(summary.imported, 4);
    assert.equal(summary.rejected, 0);
    assert.deepEqual(
      summary.results.map((result) => result.mappedState),
      ["draft", "finalized:open", "finalized:accepted", "finalized:declined"],
    );
  });

  it("reports rejected rows without aborting the rest of the run", async () => {
    const { fn } = inMemoryImporter();
    const quotes = [
      legacyQuote({ id: "q1", number: "Q-1", lineItems: [] }),
      legacyQuote({ id: "q2", number: "Q-2" }),
    ];
    const summary = await migrateLegacyQuotes(legacyStore(quotes), fn, SERVICE_TOKEN, DEPLOYMENT);

    assert.equal(summary.total, 2);
    assert.equal(summary.imported, 1);
    assert.equal(summary.rejected, 1);
    assert.equal(summary.results[0].status, "rejected");
    assert.match(summary.results[0].rejectionReason ?? "", /no line items/);
    assert.equal(summary.results[1].status, "imported");
  });

  it("replays the exact same result for the same legacy source key without a second real import", async () => {
    const { fn, calls } = inMemoryImporter();
    const quote = legacyQuote({ id: "q1", number: "Q-1" });

    const first = await migrateLegacyQuotes(legacyStore([quote]), fn, SERVICE_TOKEN, DEPLOYMENT);
    const second = await migrateLegacyQuotes(legacyStore([quote]), fn, SERVICE_TOKEN, DEPLOYMENT);

    assert.equal(first.results[0].quoteId, second.results[0].quoteId);
    // The importer double is still called each replay (it owns the
    // idempotent-return decision, matching the real mutation), but no new
    // quote/revision identity is minted the second time.
    assert.equal(calls.length, 2);
  });
});
