/**
 * Unit tests for the quote lifecycle development smoke.
 *
 * These tests exercise the smoke function's boundary checks and prove its
 * structural contract without a real Convex backend. Repository methods are
 * stubbed with in-memory implementations that mirror the Convex adapter's
 * CAS semantics.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type QuoteDeliveryAttempt,
  type QuoteDeliveryRepository,
  type QuoteSendScope,
  type CreateQuoteDeliveryInput,
  type StartQuoteDeliveryInput,
  type BindQuoteProviderReferenceInput,
  type CompleteQuoteDeliveryInput,
  type MarkQuoteDeliveryIndeterminateInput,
  type ReconcileQuoteDeliveryInput,
  type ListQuoteDeliveriesInput,
} from "../src/quotes/quoteDeliveryRepository.js";
import type {
  QuoteRepository,
  CreateQuoteInput,
  QuoteRevisionCommand,
  FinalizeQuoteRevisionInput,
  CreateQuoteRevisionInput,
  ListQuotesInput,
  QuoteSummary,
  UpdateQuoteDraftInput,
  RecordQuoteCommercialOutcomeInput,
} from "../src/quotes/quoteRepository.js";
import type { QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";
import { runQuoteLifecycleSmoke } from "../src/tools/quoteLifecycleSmoke.js";

// ---------------------------------------------------------------------------
// Minimal in-memory QuoteRepository
// ---------------------------------------------------------------------------

type InternalRevision = {
  revisionId: string;
  ownerId: string;
  quoteId: string;
  revision: number;
  revisionVersion: number;
  status: "draft" | "reviewed" | "finalized";
  lineItems: Array<{ description: string; quantity: number; unitPrice: number }>;
  subtotal: number;
  taxRate?: number;
  tax: number;
  total: number;
  currency: "AUD";
  validUntil?: string;
  notes?: string;
  termsIncluded: boolean;
  fingerprint?: string;
  predecessorRevisionId?: string;
  historicalOutcome?: "accepted" | "declined" | "expired";
  historicalOutcomeRecordedAt?: number;
  reviewedAt?: number;
  finalizedAt?: number;
  createdAt: number;
  updatedAt: number;
};

type InternalAggregate = {
  quoteId: string;
  ownerId: string;
  clientId: string;
  projectId?: string;
  number: string;
  currentRevision: number;
  currentRevisionId: string;
  aggregateVersion: number;
  commercialStatus: "open" | "accepted" | "declined" | "expired";
  commercialRevision?: number;
  commercialRecordedAt?: number;
  createdAt: number;
  updatedAt: number;
};

class InMemoryQuoteRepository implements QuoteRepository {
  private aggregates = new Map<string, InternalAggregate>();
  private revisions = new Map<string, Map<number, InternalRevision>>();
  private nextId = 1;

  async createQuote(input: CreateQuoteInput): Promise<QuoteSnapshot> {
    const quoteId = `smoke-quote-${this.nextId++}`;
    const revisionId = `smoke-rev-${this.nextId++}`;
    const now = Date.now();
    const subtotal = input.lineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0);
    const tax = input.taxRate !== undefined ? Math.round(subtotal * input.taxRate * 100) / 100 : 0;
    const total = Math.round((subtotal + tax) * 100) / 100;

    const aggregate: InternalAggregate = {
      quoteId,
      ownerId: "owner-1",
      clientId: input.clientId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      number: input.number,
      currentRevision: 1,
      currentRevisionId: revisionId,
      aggregateVersion: 1,
      commercialStatus: "open",
      createdAt: now,
      updatedAt: now,
    };
    const revision: InternalRevision = {
      revisionId,
      ownerId: "owner-1",
      quoteId,
      revision: 1,
      revisionVersion: 1,
      status: "draft",
      lineItems: input.lineItems.map((li) => ({ ...li })),
      subtotal,
      ...(input.taxRate !== undefined ? { taxRate: input.taxRate } : {}),
      tax,
      total,
      currency: "AUD",
      ...(input.validUntil ? { validUntil: input.validUntil } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      termsIncluded: input.termsIncluded,
      createdAt: now,
      updatedAt: now,
    };

    this.aggregates.set(quoteId, aggregate);
    const revMap = new Map<number, InternalRevision>();
    revMap.set(1, revision);
    this.revisions.set(quoteId, revMap);
    return this.snapshot(quoteId);
  }

  async getQuote(quoteId: string): Promise<QuoteSnapshot | null> {
    if (!this.aggregates.has(quoteId)) return null;
    return this.snapshot(quoteId);
  }

  async listQuotes(_input: ListQuotesInput): Promise<QuoteSummary[]> {
    return [];
  }

  async updateDraft(_input: UpdateQuoteDraftInput): Promise<QuoteSnapshot> {
    throw new Error("updateDraft not used in smoke test.");
  }

  async submitForReview(input: QuoteRevisionCommand): Promise<QuoteSnapshot> {
    const revision = this.currentRevision(input.quoteId);
    revision.status = "reviewed";
    revision.revisionVersion++;
    revision.reviewedAt = Date.now();
    revision.updatedAt = Date.now();
    const agg = this.aggregates.get(input.quoteId)!;
    agg.aggregateVersion++;
    agg.updatedAt = Date.now();
    return this.snapshot(input.quoteId);
  }

  async reopenForEditing(input: QuoteRevisionCommand): Promise<QuoteSnapshot> {
    const revision = this.currentRevision(input.quoteId);
    revision.status = "draft";
    revision.revisionVersion++;
    revision.updatedAt = Date.now();
    const agg = this.aggregates.get(input.quoteId)!;
    agg.aggregateVersion++;
    agg.updatedAt = Date.now();
    return this.snapshot(input.quoteId);
  }

  async finalizeRevision(input: FinalizeQuoteRevisionInput): Promise<QuoteSnapshot> {
    const revision = this.currentRevision(input.quoteId);
    const agg = this.aggregates.get(input.quoteId)!;
    revision.status = "finalized";
    revision.revisionVersion++;
    revision.finalizedAt = Date.now();
    revision.updatedAt = Date.now();
    revision.fingerprint = `quote-revision:v1:sha256:${"a".repeat(64)}`;
    agg.aggregateVersion++;
    agg.updatedAt = Date.now();
    return this.snapshot(input.quoteId);
  }

  async createRevisionFromFinalized(input: CreateQuoteRevisionInput): Promise<QuoteSnapshot> {
    const prevRevision = this.currentRevision(input.quoteId);
    const agg = this.aggregates.get(input.quoteId)!;
    const newRevisionId = `smoke-rev-${this.nextId++}`;
    const now = Date.now();
    const newRevision: InternalRevision = {
      ...prevRevision,
      revisionId: newRevisionId,
      revision: prevRevision.revision + 1,
      revisionVersion: 1,
      status: "draft",
      predecessorRevisionId: prevRevision.revisionId,
      createdAt: now,
      updatedAt: now,
      fingerprint: undefined,
      finalizedAt: undefined,
      reviewedAt: undefined,
    };

    const revMap = this.revisions.get(input.quoteId)!;
    revMap.set(newRevision.revision, newRevision);
    agg.currentRevision = newRevision.revision;
    agg.currentRevisionId = newRevisionId;
    agg.aggregateVersion++;
    agg.commercialStatus = "open";
    delete agg.commercialRevision;
    delete agg.commercialRecordedAt;
    agg.updatedAt = now;
    return this.snapshot(input.quoteId);
  }

  async recordCommercialOutcome(_input: RecordQuoteCommercialOutcomeInput): Promise<QuoteSnapshot> {
    throw new Error("recordCommercialOutcome not used in smoke test.");
  }

  async cleanup(quoteId: string): Promise<void> {
    this.aggregates.delete(quoteId);
    this.revisions.delete(quoteId);
  }

  private currentRevision(quoteId: string): InternalRevision {
    const agg = this.aggregates.get(quoteId);
    if (!agg) throw new Error(`Quote ${quoteId} not found.`);
    const revision = this.revisions.get(quoteId)?.get(agg.currentRevision);
    if (!revision)
      throw new Error(`Revision ${agg.currentRevision} for quote ${quoteId} not found.`);
    return revision;
  }

  private snapshot(quoteId: string): QuoteSnapshot {
    const agg = this.aggregates.get(quoteId)!;
    const revision = this.revisions.get(quoteId)!.get(agg.currentRevision)!;
    return {
      aggregate: {
        quoteId: agg.quoteId,
        ownerId: agg.ownerId,
        clientId: agg.clientId,
        ...(agg.projectId !== undefined ? { projectId: agg.projectId } : {}),
        number: agg.number,
        currentRevision: agg.currentRevision,
        currentRevisionId: agg.currentRevisionId,
        aggregateVersion: agg.aggregateVersion,
        commercialStatus: agg.commercialStatus,
        ...(agg.commercialRevision !== undefined
          ? { commercialRevision: agg.commercialRevision }
          : {}),
        ...(agg.commercialRecordedAt !== undefined
          ? { commercialRecordedAt: agg.commercialRecordedAt }
          : {}),
        createdAt: agg.createdAt,
        updatedAt: agg.updatedAt,
      },
      revision: {
        revisionId: revision.revisionId,
        ownerId: revision.ownerId,
        quoteId: revision.quoteId,
        revision: revision.revision,
        revisionVersion: revision.revisionVersion,
        status: revision.status,
        lineItems: revision.lineItems.map((li) => ({ ...li })),
        subtotal: revision.subtotal,
        ...(revision.taxRate !== undefined ? { taxRate: revision.taxRate } : {}),
        tax: revision.tax,
        total: revision.total,
        currency: revision.currency,
        ...(revision.validUntil !== undefined ? { validUntil: revision.validUntil } : {}),
        ...(revision.notes !== undefined ? { notes: revision.notes } : {}),
        termsIncluded: revision.termsIncluded,
        ...(revision.fingerprint !== undefined ? { fingerprint: revision.fingerprint } : {}),
        ...(revision.predecessorRevisionId !== undefined
          ? { predecessorRevisionId: revision.predecessorRevisionId }
          : {}),
        ...(revision.historicalOutcome !== undefined
          ? { historicalOutcome: revision.historicalOutcome }
          : {}),
        ...(revision.historicalOutcomeRecordedAt !== undefined
          ? { historicalOutcomeRecordedAt: revision.historicalOutcomeRecordedAt }
          : {}),
        ...(revision.reviewedAt !== undefined ? { reviewedAt: revision.reviewedAt } : {}),
        ...(revision.finalizedAt !== undefined ? { finalizedAt: revision.finalizedAt } : {}),
        createdAt: revision.createdAt,
        updatedAt: revision.updatedAt,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Minimal in-memory QuoteDeliveryRepository
// ---------------------------------------------------------------------------

class InMemoryQuoteDeliveryRepository implements QuoteDeliveryRepository {
  private readonly bySendScope = new Map<string, QuoteDeliveryAttempt>();
  private readonly byId = new Map<string, QuoteDeliveryAttempt>();
  private nextId = 1;

  private scopeKey(scope: QuoteSendScope): string {
    return `${scope.quoteId}:${scope.revision}:${scope.recipient}:${scope.channel}`;
  }

  async getBySendScope(input: QuoteSendScope): Promise<QuoteDeliveryAttempt | null> {
    return this.bySendScope.get(this.scopeKey(input)) ?? null;
  }

  async createPending(input: CreateQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const existing = this.bySendScope.get(this.scopeKey(input));
    if (existing) return existing;
    const now = Date.now();
    const attempt: QuoteDeliveryAttempt = {
      deliveryAttemptId: `smoke-delivery-${this.nextId++}`,
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
    this.bySendScope.set(this.scopeKey(input), attempt);
    this.byId.set(attempt.deliveryAttemptId, attempt);
    return attempt;
  }

  private required(id: string): QuoteDeliveryAttempt {
    const attempt = this.byId.get(id);
    if (!attempt) throw new Error(`Quote delivery attempt ${id} not found.`);
    return attempt;
  }

  private replace(attempt: QuoteDeliveryAttempt): QuoteDeliveryAttempt {
    this.byId.set(attempt.deliveryAttemptId, attempt);
    this.bySendScope.set(this.scopeKey(attempt), attempt);
    return attempt;
  }

  async markExecuting(input: StartQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    return this.replace({
      ...this.required(input.deliveryAttemptId),
      status: "executing",
      executionStartedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async bindProviderReference(
    input: BindQuoteProviderReferenceInput,
  ): Promise<QuoteDeliveryAttempt> {
    return this.replace({
      ...this.required(input.deliveryAttemptId),
      providerRequestId: input.providerRequestId,
      ...(input.providerCorrelationId !== undefined
        ? { providerCorrelationId: input.providerCorrelationId }
        : {}),
      ...(input.reconciliationId !== undefined ? { reconciliationId: input.reconciliationId } : {}),
      updatedAt: Date.now(),
    });
  }

  async complete(input: CompleteQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    return this.replace({
      ...this.required(input.deliveryAttemptId),
      status: input.outcome,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async markIndeterminate(
    input: MarkQuoteDeliveryIndeterminateInput,
  ): Promise<QuoteDeliveryAttempt> {
    return this.replace({
      ...this.required(input.deliveryAttemptId),
      status: "indeterminate",
      reconciliationId: input.reconciliationId,
      updatedAt: Date.now(),
    });
  }

  async reconcile(input: ReconcileQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    return this.replace({
      ...this.required(input.deliveryAttemptId),
      status: "reconciled",
      reconciledOutcome: input.outcome,
      reconciledAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async listForQuote(input: ListQuoteDeliveriesInput): Promise<QuoteDeliveryAttempt[]> {
    return [...this.byId.values()].filter(
      (a) =>
        a.quoteId === input.quoteId &&
        (input.revision === undefined || a.revision === input.revision),
    );
  }

  async cleanup(quoteId: string, revision?: number): Promise<void> {
    for (const [key, attempt] of this.bySendScope.entries()) {
      if (
        attempt.quoteId === quoteId &&
        (revision === undefined || attempt.revision === revision)
      ) {
        this.bySendScope.delete(key);
      }
    }
    for (const [id, attempt] of this.byId.entries()) {
      if (
        attempt.quoteId === quoteId &&
        (revision === undefined || attempt.revision === revision)
      ) {
        this.byId.delete(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("quote lifecycle smoke: development deployment guard", () => {
  it("refuses non-development deployments", async () => {
    await assert.rejects(
      () =>
        runQuoteLifecycleSmoke(
          () => new InMemoryQuoteRepository(),
          () => new InMemoryQuoteDeliveryRepository(),
          "prod:my-production-deployment",
          () => {},
        ),
      /dev:/,
    );
  });

  it("refuses undefined deployment", async () => {
    await assert.rejects(
      () =>
        runQuoteLifecycleSmoke(
          () => new InMemoryQuoteRepository(),
          () => new InMemoryQuoteDeliveryRepository(),
          undefined,
          () => {},
        ),
      /dev:/,
    );
  });
});

describe("quote lifecycle smoke: full lifecycle with in-memory repositories", () => {
  it("runs the full smoke lifecycle and reports all stages passed", async () => {
    const result = await runQuoteLifecycleSmoke(
      () => new InMemoryQuoteRepository(),
      () => new InMemoryQuoteDeliveryRepository(),
      "dev:smoke-test",
      () => {},
    );

    assert.equal(result.quoteCreated, true);
    assert.equal(result.revisionReviewed, true);
    assert.equal(result.revisionFinalized, true);
    assert.equal(result.freshReadImmutable, true);
    assert.equal(result.revisionForked, true);
    assert.equal(result.deliveryCreated, true);
    assert.equal(result.deliveryExecuting, true);
    assert.equal(result.providerReferencesBound, true);
    assert.equal(result.deliveryIndeterminate, true);
    assert.equal(result.deliveryReconciled, true);
    assert.equal(result.commercialStatusPreserved, true);
    assert.equal(result.cleaned, true);
  });

  it("cleans up the quote even when an assertion fails", async () => {
    // Use a faulty delivery repo that throws after creating the delivery.
    let quoteId: string | undefined;

    class FailingDeliveryRepository extends InMemoryQuoteDeliveryRepository {
      override async markExecuting(_input: StartQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
        throw new Error("Injected failure during markExecuting.");
      }
    }

    class TrackingQuoteRepository extends InMemoryQuoteRepository {
      override async createQuote(input: CreateQuoteInput): Promise<QuoteSnapshot> {
        const snapshot = await super.createQuote(input);
        quoteId = snapshot.aggregate.quoteId;
        return snapshot;
      }

      override async cleanup(qid: string): Promise<void> {
        await super.cleanup(qid);
      }
    }

    const repo = new TrackingQuoteRepository();

    await assert.rejects(
      () =>
        runQuoteLifecycleSmoke(
          () => repo,
          () => new FailingDeliveryRepository(),
          "dev:smoke-test",
          () => {},
        ),
      /Injected failure/,
    );

    // After the smoke fails, the quote should have been cleaned up.
    assert.ok(quoteId !== undefined, "quoteId should have been set during smoke.");
    const afterCleanup = await repo.getQuote(quoteId);
    assert.equal(afterCleanup, null, "Quote should be cleaned up even on smoke failure.");
  });
});
