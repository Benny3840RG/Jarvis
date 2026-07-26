import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolAction } from "../src/actions/toolActions.js";
import { ToolExecutionService } from "../src/actions/toolExecution.js";
import { createQuoteFinalizeToolDefinition } from "../src/actions/quoteFinalizeTool.js";
import { QuoteInvalidTransitionError, type QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";
import type {
  FinalizeQuoteRevisionInput,
  QuoteRepository,
  QuoteSummary,
} from "../src/quotes/quoteRepository.js";

function action(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "action-finalize-1",
    requestId: "request-finalize-1",
    projectId: "project-1",
    baseRevision: 1,
    state: "approved",
    tool: "quotes",
    operation: "finalize",
    arguments: {
      quoteId: "quote-1",
      quoteRevision: 1,
      expectedAggregateVersion: 3,
      expectedRevisionVersion: 2,
    },
    rationale: "Finalize the reviewed quote.",
    requiredAuthority: "T2",
    destructive: false,
    idempotencyKey: "proposal-finalize-1",
    proposedBy: "agent",
    approvedBy: "user",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    approvedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

function snapshotWith(fingerprint = "quote-revision:v1:sha256:aaaa"): QuoteSnapshot {
  return {
    aggregate: {
      quoteId: "quote-1",
      ownerId: "owner-1",
      clientId: "client-1",
      number: "Q-1",
      currentRevision: 1,
      currentRevisionId: "revision-1",
      aggregateVersion: 4,
      commercialStatus: "open",
      createdAt: 1,
      updatedAt: 1,
    },
    revision: {
      revisionId: "revision-1",
      ownerId: "owner-1",
      quoteId: "quote-1",
      revision: 1,
      revisionVersion: 3,
      status: "finalized",
      lineItems: [{ description: "Fence panel", quantity: 2, unitPrice: 150 }],
      subtotal: 300,
      tax: 0,
      total: 300,
      currency: "AUD",
      termsIncluded: true,
      fingerprint,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

type FinalizeBehavior = (input: FinalizeQuoteRevisionInput) => Promise<QuoteSnapshot>;

function quoteRepositoryStub(finalize: FinalizeBehavior): QuoteRepository {
  return {
    async createQuote(): Promise<QuoteSnapshot> {
      throw new Error("createQuote is not used in this test.");
    },
    async getQuote(): Promise<QuoteSnapshot | null> {
      throw new Error("getQuote is not used in this test.");
    },
    async listQuotes(): Promise<QuoteSummary[]> {
      throw new Error("listQuotes is not used in this test.");
    },
    async updateDraft(): Promise<QuoteSnapshot> {
      throw new Error("updateDraft is not used in this test.");
    },
    async submitForReview(): Promise<QuoteSnapshot> {
      throw new Error("submitForReview is not used in this test.");
    },
    async reopenForEditing(): Promise<QuoteSnapshot> {
      throw new Error("reopenForEditing is not used in this test.");
    },
    finalizeRevision: finalize,
    async createRevisionFromFinalized(): Promise<QuoteSnapshot> {
      throw new Error("createRevisionFromFinalized is not used in this test.");
    },
    async recordCommercialOutcome(): Promise<QuoteSnapshot> {
      throw new Error("recordCommercialOutcome is not used in this test.");
    },
    async cleanup(): Promise<void> {
      throw new Error("cleanup is not used in this test.");
    },
  };
}

describe("AM-012 finalize quote tool", () => {
  it("finalizes a reviewed revision and returns its stamped fingerprint", async () => {
    let calls = 0;
    const quotes = quoteRepositoryStub(async (input) => {
      calls += 1;
      assert.equal(input.quoteId, "quote-1");
      assert.equal(input.revision, 1);
      assert.equal(input.expectedAggregateVersion, 3);
      assert.equal(input.expectedRevisionVersion, 2);
      return snapshotWith();
    });
    const service = new ToolExecutionService([createQuoteFinalizeToolDefinition(quotes)]);

    const result = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "execute-finalize-1",
    });

    assert.equal(result.status, "succeeded");
    assert.equal(calls, 1);
  });

  it("returns the exact original result on an identical replay without calling the repository again", async () => {
    let calls = 0;
    const quotes = quoteRepositoryStub(async () => {
      calls += 1;
      return snapshotWith();
    });
    const service = new ToolExecutionService([createQuoteFinalizeToolDefinition(quotes)]);

    const first = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "execute-finalize-replay",
    });
    const second = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "execute-finalize-replay",
    });

    assert.equal(first.status, "succeeded");
    assert.equal(second.receiptId, first.receiptId);
    assert.equal(second.outputDigest, first.outputDigest);
    assert.equal(calls, 1);
  });

  it("rejects a changed request replayed under the same idempotency key without calling the repository again", async () => {
    let calls = 0;
    const quotes = quoteRepositoryStub(async () => {
      calls += 1;
      return snapshotWith();
    });
    const service = new ToolExecutionService([createQuoteFinalizeToolDefinition(quotes)]);

    const first = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "execute-finalize-changed",
    });
    const second = await service.execute({
      action: action({ arguments: { ...action().arguments, quoteRevision: 2 } }),
      authority: "T2",
      idempotencyKey: "execute-finalize-changed",
    });

    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "blocked");
    assert.equal(second.errorCode, "fingerprint-mismatch");
    assert.equal(calls, 1);
  });

  it("fails without a second attempt when finalizing a non-reviewed revision", async () => {
    const quotes = quoteRepositoryStub(async () => {
      throw new QuoteInvalidTransitionError("Quote revision must be reviewed before finalizing.");
    });
    const service = new ToolExecutionService([createQuoteFinalizeToolDefinition(quotes)]);

    const result = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "execute-finalize-draft",
    });

    assert.equal(result.status, "failed");
  });

  it("blocks malformed arguments before the repository is ever called", async () => {
    let calls = 0;
    const quotes = quoteRepositoryStub(async () => {
      calls += 1;
      return snapshotWith();
    });
    const service = new ToolExecutionService([createQuoteFinalizeToolDefinition(quotes)]);

    const result = await service.execute({
      action: action({ arguments: { ...action().arguments, quoteRevision: "not-a-number" } }),
      authority: "T2",
      idempotencyKey: "execute-finalize-invalid",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "invalid-arguments");
    assert.equal(calls, 0);
  });
});
