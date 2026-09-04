import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeQuoteTotals,
  type QuoteAggregate,
  type QuoteRevision,
  type QuoteSnapshot,
} from "../src/quotes/quoteLifecycle.js";
import type {
  CreateQuoteInput,
  CreateQuoteRevisionInput,
  FinalizeQuoteRevisionInput,
  ListQuotesInput,
  QuoteRepository,
  QuoteRevisionCommand,
  QuoteSummary,
  RecordQuoteCommercialOutcomeInput,
  UpdateQuoteDraftInput,
} from "../src/quotes/quoteRepository.js";
import type {
  BindQuoteProviderReferenceInput,
  CompleteQuoteDeliveryInput,
  CreateQuoteDeliveryInput,
  ListQuoteDeliveriesInput,
  MarkQuoteDeliveryIndeterminateInput,
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
  QuoteSendScope,
  ReconcileQuoteDeliveryInput,
  StartQuoteDeliveryInput,
} from "../src/quotes/quoteDeliveryRepository.js";
import { runQuoteLifecycleSmoke } from "../src/tools/quoteLifecycleSmoke.js";

type Backend = {
  aggregates: Map<string, QuoteAggregate>;
  revisions: Map<string, QuoteRevision>;
  deliveries: Map<string, QuoteDeliveryAttempt>;
  quoteCleanupCalls: number;
  deliveryCleanupCalls: number;
  failFork: boolean;
};

function backend(): Backend {
  return {
    aggregates: new Map(),
    revisions: new Map(),
    deliveries: new Map(),
    quoteCleanupCalls: 0,
    deliveryCleanupCalls: 0,
    failFork: false,
  };
}

/** In-memory double of `ConvexQuoteRepository`, mirroring the real transition/version-conflict semantics the smoke relies on. */
class SharedFakeQuoteRepository implements QuoteRepository {
  constructor(private readonly backend: Backend) {}

  async createQuote(
    input: CreateQuoteInput,
  ): Promise<{ aggregate: QuoteAggregate; revision: QuoteRevision }> {
    const quoteId = randomUUID();
    const revisionId = randomUUID();
    const totals = computeQuoteTotals(input.lineItems, input.taxRate);
    const now = Date.now();
    const aggregate: QuoteAggregate = {
      quoteId,
      ownerId: "owner-1",
      clientId: input.clientId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      number: input.number,
      currentRevision: 1,
      currentRevisionId: revisionId,
      aggregateVersion: 1,
      commercialStatus: "open",
      createdAt: now,
      updatedAt: now,
    };
    const revision: QuoteRevision = {
      revisionId,
      ownerId: "owner-1",
      quoteId,
      revision: 1,
      revisionVersion: 1,
      status: "draft",
      lineItems: input.lineItems,
      subtotal: totals.subtotal,
      ...(input.taxRate === undefined ? {} : { taxRate: input.taxRate }),
      tax: totals.tax,
      total: totals.total,
      currency: "AUD",
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      termsIncluded: input.termsIncluded,
      createdAt: now,
      updatedAt: now,
    };
    this.backend.aggregates.set(quoteId, aggregate);
    this.backend.revisions.set(revisionId, revision);
    return { aggregate, revision };
  }

  async getQuote(quoteId: string) {
    const aggregate = this.backend.aggregates.get(quoteId);
    if (!aggregate) return null;
    const revision = this.backend.revisions.get(aggregate.currentRevisionId);
    if (!revision) throw new Error("fake: missing current revision");
    return { aggregate, revision };
  }

  async listQuotes(_input: ListQuotesInput): Promise<QuoteSummary[]> {
    throw new Error("not used by smoke");
  }

  async updateDraft(_input: UpdateQuoteDraftInput): Promise<QuoteSnapshot> {
    throw new Error("not used by smoke");
  }

  async submitForReview(input: QuoteRevisionCommand): Promise<QuoteSnapshot> {
    const { aggregate, revision } = this.required(input.quoteId, input.revision);
    this.requireVersions(aggregate, revision, input);
    const updated: QuoteRevision = {
      ...revision,
      status: "reviewed",
      revisionVersion: revision.revisionVersion + 1,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.backend.revisions.set(updated.revisionId, updated);
    return { aggregate, revision: updated };
  }

  async reopenForEditing(_input: QuoteRevisionCommand): Promise<QuoteSnapshot> {
    throw new Error("not used by smoke");
  }

  async finalizeRevision(input: FinalizeQuoteRevisionInput): Promise<QuoteSnapshot> {
    const { aggregate, revision } = this.required(input.quoteId, input.revision);
    this.requireVersions(aggregate, revision, input);
    const updated: QuoteRevision = {
      ...revision,
      status: "finalized",
      revisionVersion: revision.revisionVersion + 1,
      fingerprint: `fingerprint:${revision.revisionId}`,
      finalizedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.backend.revisions.set(updated.revisionId, updated);
    return { aggregate, revision: updated };
  }

  async createRevisionFromFinalized(input: CreateQuoteRevisionInput): Promise<QuoteSnapshot> {
    if (this.backend.failFork) throw new Error("injected fork failure");
    const { aggregate, revision } = this.required(input.quoteId, input.revision);
    this.requireVersions(aggregate, revision, input);
    if (revision.fingerprint !== input.expectedFingerprint) {
      throw new Error("fake: fingerprint mismatch");
    }
    const now = Date.now();
    const newRevision: QuoteRevision = {
      ownerId: revision.ownerId,
      quoteId: revision.quoteId,
      revisionId: randomUUID(),
      revision: revision.revision + 1,
      revisionVersion: 1,
      status: "draft",
      lineItems: revision.lineItems,
      subtotal: revision.subtotal,
      ...(revision.taxRate === undefined ? {} : { taxRate: revision.taxRate }),
      tax: revision.tax,
      total: revision.total,
      currency: revision.currency,
      ...(revision.validUntil === undefined ? {} : { validUntil: revision.validUntil }),
      ...(revision.notes === undefined ? {} : { notes: revision.notes }),
      termsIncluded: revision.termsIncluded,
      predecessorRevisionId: revision.revisionId,
      createdAt: now,
      updatedAt: now,
    };
    const newAggregate: QuoteAggregate = {
      ...aggregate,
      currentRevision: newRevision.revision,
      currentRevisionId: newRevision.revisionId,
      aggregateVersion: aggregate.aggregateVersion + 1,
      updatedAt: now,
    };
    this.backend.revisions.set(newRevision.revisionId, newRevision);
    this.backend.aggregates.set(aggregate.quoteId, newAggregate);
    return { aggregate: newAggregate, revision: newRevision };
  }

  async recordCommercialOutcome(_input: RecordQuoteCommercialOutcomeInput): Promise<QuoteSnapshot> {
    throw new Error("not used by smoke");
  }

  async cleanup(quoteId: string): Promise<boolean> {
    this.backend.quoteCleanupCalls += 1;
    const aggregate = this.backend.aggregates.get(quoteId);
    if (!aggregate) return false;
    for (const [id, revision] of [...this.backend.revisions.entries()]) {
      if (revision.quoteId === quoteId) this.backend.revisions.delete(id);
    }
    this.backend.aggregates.delete(quoteId);
    return true;
  }

  private required(
    quoteId: string,
    revisionNumber: number,
  ): { aggregate: QuoteAggregate; revision: QuoteRevision } {
    const aggregate = this.backend.aggregates.get(quoteId);
    if (!aggregate) throw new Error("fake: quote not found");
    const revision = [...this.backend.revisions.values()].find(
      (candidate) => candidate.quoteId === quoteId && candidate.revision === revisionNumber,
    );
    if (!revision) throw new Error("fake: revision not found");
    return { aggregate, revision };
  }

  private requireVersions(
    aggregate: QuoteAggregate,
    revision: QuoteRevision,
    input: { expectedAggregateVersion: number; expectedRevisionVersion: number },
  ): void {
    if (
      aggregate.aggregateVersion !== input.expectedAggregateVersion ||
      revision.revisionVersion !== input.expectedRevisionVersion
    ) {
      throw new Error("fake: version conflict");
    }
  }
}

/** In-memory double of `ConvexQuoteDeliveryRepository`. */
class SharedFakeQuoteDeliveryRepository implements QuoteDeliveryRepository {
  constructor(private readonly backend: Backend) {}

  async getBySendScope(_input: QuoteSendScope): Promise<QuoteDeliveryAttempt | null> {
    throw new Error("not used by smoke");
  }

  async createPending(input: CreateQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const deliveryAttemptId = randomUUID();
    const now = Date.now();
    const attempt: QuoteDeliveryAttempt = {
      deliveryAttemptId,
      ownerId: "owner-1",
      quoteId: input.quoteId,
      revision: input.revision,
      revisionId: input.revisionId,
      revisionFingerprint: input.revisionFingerprint,
      recipient: input.recipient,
      channel: input.channel,
      sendFingerprint: input.sendFingerprint,
      idempotencyKey: input.idempotencyKey,
      approvalId: input.approvalId,
      actionFingerprint: input.actionFingerprint,
      status: "pending",
      provider: input.provider,
      createdAt: now,
      updatedAt: now,
    };
    this.backend.deliveries.set(deliveryAttemptId, attempt);
    return attempt;
  }

  async markExecuting(input: StartQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const attempt = this.required(input.deliveryAttemptId);
    this.requireStatus(attempt, input.expectedStatus);
    return this.replace({
      ...attempt,
      status: "executing",
      executionStartedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async bindProviderReference(
    input: BindQuoteProviderReferenceInput,
  ): Promise<QuoteDeliveryAttempt> {
    const attempt = this.required(input.deliveryAttemptId);
    this.requireStatus(attempt, input.expectedStatus);
    return this.replace({
      ...attempt,
      providerRequestId: input.providerRequestId,
      ...(input.providerCorrelationId === undefined
        ? {}
        : { providerCorrelationId: input.providerCorrelationId }),
      ...(input.reconciliationId === undefined ? {} : { reconciliationId: input.reconciliationId }),
      updatedAt: Date.now(),
    });
  }

  async complete(_input: CompleteQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    throw new Error("not used by smoke");
  }

  async markIndeterminate(
    input: MarkQuoteDeliveryIndeterminateInput,
  ): Promise<QuoteDeliveryAttempt> {
    const attempt = this.required(input.deliveryAttemptId);
    this.requireStatus(attempt, input.expectedStatus);
    return this.replace({
      ...attempt,
      status: "indeterminate",
      reconciliationId: input.reconciliationId,
      updatedAt: Date.now(),
    });
  }

  async reconcile(input: ReconcileQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const attempt = this.required(input.deliveryAttemptId);
    this.requireStatus(attempt, input.expectedStatus);
    if (attempt.reconciliationId !== input.reconciliationId) {
      throw new Error("fake: reconciliation mismatch");
    }
    return this.replace({
      ...attempt,
      status: "reconciled",
      reconciledOutcome: input.outcome,
      reconciledAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async listForQuote(input: ListQuoteDeliveriesInput): Promise<QuoteDeliveryAttempt[]> {
    return [...this.backend.deliveries.values()].filter(
      (attempt) => attempt.quoteId === input.quoteId,
    );
  }

  async cleanup(quoteId: string): Promise<boolean> {
    this.backend.deliveryCleanupCalls += 1;
    let removed = false;
    for (const [id, attempt] of [...this.backend.deliveries.entries()]) {
      if (attempt.quoteId === quoteId) {
        this.backend.deliveries.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  private required(deliveryAttemptId: string): QuoteDeliveryAttempt {
    const attempt = this.backend.deliveries.get(deliveryAttemptId);
    if (!attempt) throw new Error("fake: delivery attempt not found");
    return attempt;
  }

  private requireStatus(
    attempt: QuoteDeliveryAttempt,
    expected: QuoteDeliveryAttempt["status"],
  ): void {
    if (attempt.status !== expected) {
      throw new Error(`fake: attempt is ${attempt.status}, expected ${expected}`);
    }
  }

  private replace(attempt: QuoteDeliveryAttempt): QuoteDeliveryAttempt {
    this.backend.deliveries.set(attempt.deliveryAttemptId, attempt);
    return attempt;
  }
}

describe("runQuoteLifecycleSmoke", () => {
  it("refuses non-development deployments before constructing repositories", async () => {
    let constructions = 0;
    const shared = backend();

    await assert.rejects(
      runQuoteLifecycleSmoke(
        () => {
          constructions += 1;
          return new SharedFakeQuoteRepository(shared);
        },
        () => {
          constructions += 1;
          return new SharedFakeQuoteDeliveryRepository(shared);
        },
        "prod:jarvis",
      ),
      /must identify a development deployment/,
    );

    assert.equal(constructions, 0);
  });

  it("constructs every required repository before creating synthetic state", async () => {
    const shared = backend();

    await assert.rejects(
      runQuoteLifecycleSmoke(
        () => new SharedFakeQuoteRepository(shared),
        () => {
          throw new Error("quote delivery runtime credential is unavailable");
        },
        "dev:outgoing-ram-798",
      ),
      /quote delivery runtime credential is unavailable/,
    );

    assert.equal(shared.aggregates.size, 0);
    assert.equal(shared.revisions.size, 0);
    assert.equal(shared.quoteCleanupCalls, 0);
    assert.equal(shared.deliveryCleanupCalls, 0);
  });

  it("runs the full quote lifecycle and delivery ledger, then cleans all synthetic state", async () => {
    const shared = backend();
    const messages: string[] = [];

    const result = await runQuoteLifecycleSmoke(
      () => new SharedFakeQuoteRepository(shared),
      () => new SharedFakeQuoteDeliveryRepository(shared),
      "dev:outgoing-ram-798",
      (message) => messages.push(message),
    );

    assert.deepEqual(result, {
      quoteCreated: true,
      revisionReviewed: true,
      revisionFinalized: true,
      freshReadImmutable: true,
      revisionForked: true,
      deliveryCreated: true,
      deliveryExecuting: true,
      providerReferencesBound: true,
      deliveryIndeterminate: true,
      deliveryReconciled: true,
      commercialStatusPreserved: true,
      cleaned: true,
    });
    assert.equal(shared.quoteCleanupCalls, 1);
    assert.equal(shared.deliveryCleanupCalls, 1);
    assert.equal(shared.aggregates.size, 0);
    assert.equal(shared.revisions.size, 0);
    assert.equal(shared.deliveries.size, 0);
    assert.equal(messages.length, 1);
  });

  it("cleans synthetic quote state after an injected fork failure", async () => {
    const shared = backend();
    shared.failFork = true;

    await assert.rejects(
      runQuoteLifecycleSmoke(
        () => new SharedFakeQuoteRepository(shared),
        () => new SharedFakeQuoteDeliveryRepository(shared),
        "dev:outgoing-ram-798",
      ),
      /injected fork failure/,
    );

    assert.equal(shared.quoteCleanupCalls, 1);
    assert.equal(shared.aggregates.size, 0);
    assert.equal(shared.revisions.size, 0);
  });
});
