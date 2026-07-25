import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolAction } from "../src/actions/toolActions.js";
import { ToolExecutionService, type ToolExecutionReceipt } from "../src/actions/toolExecution.js";
import { createToolExecutionDefinitions } from "../src/actions/toolExecutionFactory.js";
import { createQuoteSendToolDefinition } from "../src/actions/quoteSendTool.js";
import type {
  QuoteEmailProvider,
  QuoteEmailSendInput,
  QuoteEmailSendResult,
} from "../src/quotes/quoteEmailProvider.js";
import type { QuoteAggregate, QuoteRevision, QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";
import type { QuoteRepository, QuoteSummary } from "../src/quotes/quoteRepository.js";
import type { NoteStore } from "../src/notes/note.js";
import type {
  CompleteExternalAttemptInput,
  ExternalExecutionScope,
  ExternalReconciliationClaim,
  ExternalReconciliationEnvelope,
  ExternalReconciliationRecord,
  ExternalReconciliationStore,
  MarkExternalIndeterminateInput,
  ProviderReconciliationResult,
  RegisterExternalAttemptInput,
} from "../src/reconciliation/externalReconciliation.js";

function action(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "action-send-1",
    requestId: "request-send-1",
    projectId: "project-1",
    baseRevision: 1,
    state: "approved",
    tool: "quotes",
    operation: "send",
    arguments: {
      quoteId: "quote-1",
      quoteRevision: 1,
      recipient: "client@example.com",
      deliveryChannel: "email",
    },
    rationale: "Send the finalized quote to the client.",
    requiredAuthority: "T2",
    destructive: false,
    idempotencyKey: "proposal-send-1",
    proposedBy: "agent",
    approvedBy: "user",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    approvedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(
  aggregateOverrides: Partial<QuoteAggregate> = {},
  revisionOverrides: Partial<QuoteRevision> = {},
): QuoteSnapshot {
  return {
    aggregate: {
      quoteId: "quote-1",
      ownerId: "owner-1",
      clientId: "client-1",
      number: "Q-1",
      currentRevision: 1,
      currentRevisionId: "revision-1",
      aggregateVersion: 3,
      commercialStatus: "open",
      createdAt: 1,
      updatedAt: 1,
      ...aggregateOverrides,
    },
    revision: {
      revisionId: "revision-1",
      ownerId: "owner-1",
      quoteId: "quote-1",
      revision: 1,
      revisionVersion: 2,
      status: "finalized",
      lineItems: [{ description: "Fence panel", quantity: 2, unitPrice: 150 }],
      subtotal: 300,
      tax: 0,
      total: 300,
      currency: "AUD",
      termsIncluded: true,
      fingerprint: "quote-revision:v1:sha256:aaaa",
      createdAt: 1,
      updatedAt: 1,
      ...revisionOverrides,
    },
  };
}

function quoteRepositoryStub(current: QuoteSnapshot | null): QuoteRepository {
  return {
    async createQuote(): Promise<QuoteSnapshot> {
      throw new Error("createQuote is not used in this test.");
    },
    async getQuote(quoteId: string): Promise<QuoteSnapshot | null> {
      return current && current.aggregate.quoteId === quoteId ? current : null;
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
    async finalizeRevision(): Promise<QuoteSnapshot> {
      throw new Error("finalizeRevision is not used in this test.");
    },
    async createRevisionFromFinalized(): Promise<QuoteSnapshot> {
      throw new Error("createRevisionFromFinalized is not used in this test.");
    },
    async recordCommercialOutcome(): Promise<QuoteSnapshot> {
      throw new Error("recordCommercialOutcome is not used in this test.");
    },
  };
}

class RecordingEmailProvider implements QuoteEmailProvider {
  readonly name = "test-email-provider";
  readonly calls: QuoteEmailSendInput[] = [];
  result: QuoteEmailSendResult = {
    providerRequestId: "provider-request-1",
    providerCorrelationId: "provider-correlation-1",
  };

  async send(input: QuoteEmailSendInput): Promise<QuoteEmailSendResult> {
    this.calls.push(input);
    return this.result;
  }
}

/** Minimal in-memory ExternalReconciliationStore, trimmed from toolExecutionReconciliation.test.ts. */
class FakeReconciliationStore implements ExternalReconciliationStore {
  envelope: ExternalReconciliationEnvelope | null = null;

  async getByScope(scope: ExternalExecutionScope): Promise<ExternalReconciliationEnvelope | null> {
    const current = this.envelope;
    if (!current) return null;
    const record = current.reconciliation;
    if (
      record.projectId !== scope.projectId ||
      record.tool !== scope.tool ||
      record.operation !== scope.operation ||
      record.idempotencyKey !== scope.idempotencyKey
    ) {
      return null;
    }
    if (record.effectFingerprint !== scope.effectFingerprint) {
      throw new Error("effect fingerprint collision");
    }
    return current;
  }

  async registerAttempt(
    input: RegisterExternalAttemptInput,
  ): Promise<ExternalReconciliationRecord> {
    const now = Date.now();
    const record: ExternalReconciliationRecord = {
      reconciliationId: input.reconciliationId,
      executionKey: input.executionKey,
      actionId: input.actionId,
      requestId: input.requestId,
      projectId: input.projectId,
      tool: input.tool,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint: input.actionFingerprint,
      effectFingerprint: input.effectFingerprint,
      provider: input.reference.provider,
      providerRequestId: input.reference.providerRequestId,
      providerCorrelationId: input.reference.providerCorrelationId,
      state: "observing",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.envelope = { reconciliation: record, receipt: null };
    return record;
  }

  async markIndeterminate(
    input: MarkExternalIndeterminateInput,
  ): Promise<ExternalReconciliationEnvelope> {
    const now = Date.now();
    const current = this.envelope?.reconciliation;
    const record: ExternalReconciliationRecord = {
      reconciliationId: input.reconciliationId,
      executionKey: input.executionKey,
      actionId: input.actionId,
      requestId: input.requestId,
      projectId: input.projectId,
      tool: input.tool,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint: input.actionFingerprint,
      effectFingerprint: input.effectFingerprint,
      provider: input.expectedProvider,
      ...(current?.providerRequestId === undefined
        ? {}
        : { providerRequestId: current.providerRequestId }),
      providerCorrelationId:
        current?.providerCorrelationId ??
        input.receipt.providerCorrelationId ??
        input.receipt.correlationId,
      receiptKey: input.receiptKey,
      receiptId: input.receipt.receiptId,
      state: current?.providerRequestId ? "pending" : "escalated",
      attemptCount: current?.attemptCount ?? 0,
      nextAttemptAt: now,
      ...(current?.providerRequestId
        ? {}
        : {
            escalationReason: input.missingReferenceReason ?? "provider-reference-missing",
            escalatedAt: now,
          }),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    const receipt: ToolExecutionReceipt = {
      ...input.receipt,
      provider: input.expectedProvider,
      ...(record.providerRequestId === undefined
        ? {}
        : { providerRequestId: record.providerRequestId }),
      providerCorrelationId: record.providerCorrelationId,
      reconciliationId: record.reconciliationId,
    };
    this.envelope = { reconciliation: record, receipt };
    return this.envelope;
  }

  async completeAttempt(
    input: CompleteExternalAttemptInput,
  ): Promise<ExternalReconciliationEnvelope> {
    const current = this.envelope?.reconciliation;
    if (!current?.providerRequestId) throw new Error("provider reference is missing");
    const now = Date.now();
    const record: ExternalReconciliationRecord = {
      ...current,
      receiptKey: input.receiptKey,
      receiptId: input.receipt.receiptId,
      state: "resolved",
      terminalStatus: input.receipt.status as "succeeded" | "failed",
      updatedAt: now,
      resolvedAt: now,
    };
    const receipt: ToolExecutionReceipt = {
      ...input.receipt,
      provider: input.expectedProvider,
      providerRequestId: current.providerRequestId,
      providerCorrelationId: current.providerCorrelationId,
      reconciliationId: current.reconciliationId,
    };
    this.envelope = { reconciliation: record, receipt };
    return this.envelope;
  }

  async claimNext(): Promise<ExternalReconciliationClaim | null> {
    return null;
  }

  async resolveClaim(_input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    result: Exclude<ProviderReconciliationResult, { status: "unresolved" }>;
  }): Promise<ToolExecutionReceipt> {
    throw new Error("not used in this test");
  }

  async releaseClaim(_input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    errorCode: string;
    nextAttemptAt: number;
    maxAttempts: number;
  }): Promise<ExternalReconciliationRecord> {
    throw new Error("not used in this test");
  }

  async cleanup(): Promise<boolean> {
    this.envelope = null;
    return true;
  }
}

describe("AM-013 send quote tool", () => {
  it("sends a finalized quote and registers the provider attempt", async () => {
    const provider = new RecordingEmailProvider();
    const quotes = quoteRepositoryStub(snapshot());
    const reconciliations = new FakeReconciliationStore();
    const service = new ToolExecutionService(
      [createQuoteSendToolDefinition(quotes, provider)],
      undefined,
      reconciliations,
    );

    const result = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "execute-send-1",
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.provider, "test-email-provider");
    assert.equal(result.providerRequestId, "provider-request-1");
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].recipient, "client@example.com");
    assert.equal(provider.calls[0].revision.revisionId, "revision-1");
  });

  it("fails without contacting the provider when the revision is stale", async () => {
    const provider = new RecordingEmailProvider();
    const quotes = quoteRepositoryStub(
      snapshot({ currentRevision: 2, currentRevisionId: "revision-2" }),
    );
    const reconciliations = new FakeReconciliationStore();
    const service = new ToolExecutionService(
      [createQuoteSendToolDefinition(quotes, provider)],
      undefined,
      reconciliations,
    );

    const result = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "execute-send-stale",
    });

    assert.equal(result.status, "failed");
    assert.equal(provider.calls.length, 0);
  });

  it("fails without contacting the provider when the revision is not finalized", async () => {
    const provider = new RecordingEmailProvider();
    const quotes = quoteRepositoryStub(
      snapshot({}, { status: "reviewed", fingerprint: undefined }),
    );
    const reconciliations = new FakeReconciliationStore();
    const service = new ToolExecutionService(
      [createQuoteSendToolDefinition(quotes, provider)],
      undefined,
      reconciliations,
    );

    const result = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "execute-send-unfinalized",
    });

    assert.equal(result.status, "failed");
    assert.equal(provider.calls.length, 0);
  });

  it("fails without contacting the provider when the quote does not exist", async () => {
    const provider = new RecordingEmailProvider();
    const quotes = quoteRepositoryStub(null);
    const reconciliations = new FakeReconciliationStore();
    const service = new ToolExecutionService(
      [createQuoteSendToolDefinition(quotes, provider)],
      undefined,
      reconciliations,
    );

    const result = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "execute-send-missing",
    });

    assert.equal(result.status, "failed");
    assert.equal(provider.calls.length, 0);
  });

  it("blocks malformed arguments before the repository or provider are ever called", async () => {
    const provider = new RecordingEmailProvider();
    const quotes = quoteRepositoryStub(snapshot());
    const reconciliations = new FakeReconciliationStore();
    const service = new ToolExecutionService(
      [createQuoteSendToolDefinition(quotes, provider)],
      undefined,
      reconciliations,
    );

    const result = await service.execute({
      action: action({ arguments: { ...action().arguments, recipient: "not-an-email" } }),
      authority: "T2",
      idempotencyKey: "execute-send-invalid",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "invalid-arguments");
    assert.equal(provider.calls.length, 0);
  });

  it("is allowlisted only when both a quote repository and an email provider are supplied", async () => {
    const noteStore: NoteStore = {
      async create() {
        throw new Error("not used in this test");
      },
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async remove() {
        return null;
      },
    };
    const store = quoteRepositoryStub(snapshot());
    const withoutProvider = createToolExecutionDefinitions(
      noteStore,
      undefined,
      undefined,
      store,
      undefined,
    );
    assert.equal(
      withoutProvider.some(({ tool, operation }) => `${tool}:${operation}` === "quotes:send"),
      false,
    );

    const withProvider = createToolExecutionDefinitions(
      noteStore,
      undefined,
      undefined,
      store,
      new RecordingEmailProvider(),
    );
    assert.equal(
      withProvider.some(({ tool, operation }) => `${tool}:${operation}` === "quotes:send"),
      true,
    );
  });
});
