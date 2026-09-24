import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  GovernedExternalOperation,
  PolicyEngineNotAuthorityError,
  createGovernedExternalOperationFromEnv,
} from "../src/actions/governedExternalOperation.js";
import { createQuoteSendToolDefinition } from "../src/actions/quoteSendTool.js";
import type { ToolAction, ToolActionService } from "../src/actions/toolActions.js";
import {
  ToolExecutionService,
  type ExecutionEligibilityStore,
  type SingleUseConsumptionClaimStore,
  type SingleUseExecutionClaimResult,
  type ToolExecutionReceipt,
} from "../src/actions/toolExecution.js";
import {
  GovernedQuoteSendRefused,
  GovernedQuoteSendUnavailableError,
  executeGovernedQuoteSend,
  type GovernedQuoteSendGate,
} from "../src/preview/temporalPass/temporal/activities/governedQuoteSend.js";
import type {
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
} from "../src/quotes/quoteDeliveryRepository.js";
import type {
  QuoteEmailPrepareInput,
  QuoteEmailPreparedReference,
  QuoteEmailProvider,
  QuoteEmailSendAcceptance,
} from "../src/quotes/quoteEmailProvider.js";
import type { QuoteSnapshot } from "../src/quotes/quoteLifecycle.js";
import type { QuotePdfArtifactRepository } from "../src/quotes/quotePdfArtifactRepository.js";
import type { QuoteRepository, QuoteSummary } from "../src/quotes/quoteRepository.js";
import type {
  CompleteExternalAttemptInput,
  ExternalExecutionScope,
  ExternalReconciliationClaim,
  ExternalReconciliationEnvelope,
  ExternalReconciliationRecord,
  ExternalReconciliationStore,
  MarkExternalIndeterminateInput,
  RegisterExternalAttemptInput,
} from "../src/reconciliation/externalReconciliation.js";

const REVISION_FINGERPRINT = "quote-revision:v1:sha256:aaaa";
const PROVIDER_NAME = "microsoft-graph-mail-connections-v1";

function approvedQuoteSend(overrides: Partial<ToolAction> = {}): ToolAction {
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
      expectedRevisionFingerprint: REVISION_FINGERPRINT,
    },
    rationale: "Send one finalized quote.",
    requiredAuthority: "T2",
    destructive: false,
    idempotencyKey: "proposal-send-1",
    proposedBy: "agent",
    approvedBy: "user",
    consumptionPolicy: "single-use",
    approvalExpiryPolicy: "non-expiring",
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    approvedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(): QuoteSnapshot {
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
      fingerprint: REVISION_FINGERPRINT,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

class CountingEmailProvider implements QuoteEmailProvider {
  readonly name = PROVIDER_NAME;
  prepares = 0;
  sends = 0;

  async prepare(input: QuoteEmailPrepareInput): Promise<QuoteEmailPreparedReference> {
    this.prepares += 1;
    assert.equal(input.recipient, "client@example.com");
    return {
      providerRequestId: "graph-draft-1",
      providerCorrelationId: "graph-correlation-1",
    };
  }

  async sendPrepared(): Promise<QuoteEmailSendAcceptance> {
    this.sends += 1;
    return { status: "accepted" };
  }
}

class MemoryActions implements Pick<ToolActionService, "stage" | "get"> {
  readonly rows = new Map<string, ToolAction>();

  async stage(input: Parameters<ToolActionService["stage"]>[0]): Promise<ToolAction> {
    const staged: ToolAction = {
      actionId: input.actionId,
      requestId: input.requestId,
      projectId: input.projectId,
      baseRevision: input.expectedRevision,
      state: "proposed",
      tool: input.tool,
      operation: input.operation,
      arguments: input.arguments,
      rationale: input.rationale,
      requiredAuthority: input.requiredAuthority,
      destructive: input.destructive,
      idempotencyKey: input.idempotencyKey,
      proposedBy: input.proposedBy,
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
    };
    this.rows.set(input.actionId, staged);
    return staged;
  }

  async get(input: { actionId: string; projectId: string }): Promise<ToolAction | null> {
    const row = this.rows.get(input.actionId);
    if (!row || row.projectId !== input.projectId) return null;
    return row;
  }
}

class ExplicitClaims implements SingleUseConsumptionClaimStore {
  calls = 0;
  result: SingleUseExecutionClaimResult = { claimed: true, claimId: "pending" };

  async claim(_action: ToolAction, claimId: string): Promise<SingleUseExecutionClaimResult> {
    this.calls += 1;
    if (!this.result.claimed) return this.result;
    return { claimed: true, claimId };
  }
}

class ExplicitEligibility implements ExecutionEligibilityStore {
  calls = 0;
  result: { eligible: boolean; blockReason?: "not-approved" | "expired" } = { eligible: true };

  async verify(): Promise<{ eligible: boolean; blockReason?: "not-approved" | "expired" }> {
    this.calls += 1;
    return this.result;
  }
}

class MemoryDeliveries implements QuoteDeliveryRepository {
  attempt: QuoteDeliveryAttempt | null = null;

  async getBySendScope(): Promise<QuoteDeliveryAttempt | null> {
    return this.attempt;
  }

  async createPending(
    input: Parameters<QuoteDeliveryRepository["createPending"]>[0],
  ): Promise<QuoteDeliveryAttempt> {
    this.attempt = {
      ...input,
      deliveryAttemptId: "delivery-1",
      ownerId: "owner-1",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    };
    return this.attempt;
  }

  async markExecuting(): Promise<QuoteDeliveryAttempt> {
    this.attempt = { ...this.attempt!, status: "executing", executionStartedAt: 2, updatedAt: 2 };
    return this.attempt;
  }

  async bindProviderReference(
    input: Parameters<QuoteDeliveryRepository["bindProviderReference"]>[0],
  ): Promise<QuoteDeliveryAttempt> {
    this.attempt = {
      ...this.attempt!,
      providerRequestId: input.providerRequestId,
      providerCorrelationId: input.providerCorrelationId,
      reconciliationId: input.reconciliationId,
      updatedAt: 3,
    };
    return this.attempt;
  }

  async complete(): Promise<QuoteDeliveryAttempt> {
    this.attempt = { ...this.attempt!, status: "failed", updatedAt: 4 };
    return this.attempt;
  }

  async markIndeterminate(): Promise<QuoteDeliveryAttempt> {
    this.attempt = { ...this.attempt!, status: "indeterminate", updatedAt: 5 };
    return this.attempt;
  }

  async reconcile(): Promise<QuoteDeliveryAttempt> {
    throw new Error("reconcile is not used");
  }

  async listForQuote(): Promise<QuoteDeliveryAttempt[]> {
    return this.attempt ? [this.attempt] : [];
  }

  async cleanup(): Promise<boolean> {
    return false;
  }
}

class RecordingReconciliations implements ExternalReconciliationStore {
  envelope: ExternalReconciliationEnvelope | null = null;
  readonly markCalls: MarkExternalIndeterminateInput[] = [];

  async getByScope(scope: ExternalExecutionScope): Promise<ExternalReconciliationEnvelope | null> {
    const current = this.envelope;
    if (!current) return null;
    const record = current.reconciliation;
    if (
      record.projectId !== scope.projectId ||
      record.tool !== scope.tool ||
      record.operation !== scope.operation ||
      record.idempotencyKey !== scope.idempotencyKey ||
      record.effectFingerprint !== scope.effectFingerprint
    ) {
      return null;
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
    this.markCalls.push(input);
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
      providerCorrelationId: current?.providerCorrelationId ?? input.receipt.correlationId,
      receiptKey: input.receiptKey,
      receiptId: input.receipt.receiptId,
      state: current?.providerRequestId ? "pending" : "escalated",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    const receipt: ToolExecutionReceipt = {
      ...input.receipt,
      reconciliationId: record.reconciliationId,
      providerCorrelationId: record.providerCorrelationId,
    };
    this.envelope = { reconciliation: record, receipt };
    return this.envelope;
  }

  async completeAttempt(
    input: CompleteExternalAttemptInput,
  ): Promise<ExternalReconciliationEnvelope> {
    throw new Error(`completeAttempt is not used: ${input.reconciliationId}`);
  }

  async claimNext(): Promise<ExternalReconciliationClaim | null> {
    return null;
  }

  async resolveClaim(): Promise<ToolExecutionReceipt> {
    throw new Error("not used");
  }

  async releaseClaim(): Promise<ExternalReconciliationRecord> {
    throw new Error("not used");
  }

  async cleanup(): Promise<boolean> {
    return false;
  }
}

function quoteRepositoryStub(): QuoteRepository {
  const current = snapshot();
  return {
    async createQuote(): Promise<QuoteSnapshot> {
      throw new Error("createQuote is not used");
    },
    async getQuote(quoteId: string): Promise<QuoteSnapshot | null> {
      return current.aggregate.quoteId === quoteId ? current : null;
    },
    async listQuotes(): Promise<QuoteSummary[]> {
      throw new Error("listQuotes is not used");
    },
    async updateDraft(): Promise<QuoteSnapshot> {
      throw new Error("updateDraft is not used");
    },
    async submitForReview(): Promise<QuoteSnapshot> {
      throw new Error("submitForReview is not used");
    },
    async reopenForEditing(): Promise<QuoteSnapshot> {
      throw new Error("reopenForEditing is not used");
    },
    async finalizeRevision(): Promise<QuoteSnapshot> {
      throw new Error("finalizeRevision is not used");
    },
    async createRevisionFromFinalized(): Promise<QuoteSnapshot> {
      throw new Error("createRevisionFromFinalized is not used");
    },
    async recordCommercialOutcome(): Promise<QuoteSnapshot> {
      throw new Error("recordCommercialOutcome is not used");
    },
    async cleanup(): Promise<boolean> {
      throw new Error("cleanup is not used");
    },
  };
}

function pdfArtifacts(): QuotePdfArtifactRepository {
  return {
    async getForRevision() {
      return {
        quoteId: "quote-1",
        revisionId: "revision-1",
        revision: 1,
        revisionFingerprint: REVISION_FINGERPRINT,
        filename: "quote.pdf",
        mediaType: "application/pdf",
        digest: "quote-pdf:v1:sha256:bbbb",
        bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
        byteLength: 4,
      };
    },
  };
}

function seam(action: ToolAction = approvedQuoteSend()) {
  const provider = new CountingEmailProvider();
  const actions = new MemoryActions();
  actions.rows.set(action.actionId, action);
  const claims = new ExplicitClaims();
  const eligibility = new ExplicitEligibility();
  const reconciliations = new RecordingReconciliations();
  const execution = new ToolExecutionService(
    [
      createQuoteSendToolDefinition(
        quoteRepositoryStub(),
        provider,
        new MemoryDeliveries(),
        pdfArtifacts(),
      ),
    ],
    undefined,
    reconciliations,
    claims,
    eligibility,
  );
  const operation = new GovernedExternalOperation({ actions, execution, reconciliations });
  let executes = 0;
  const gate: GovernedQuoteSendGate = {
    propose: (input) => operation.propose(input),
    getAction: (input) => actions.get(input),
    async execute(input) {
      executes += 1;
      return operation.execute(input);
    },
  };
  return {
    provider,
    actions,
    claims,
    eligibility,
    reconciliations,
    gate,
    executes: () => executes,
  };
}

describe("Temporal quotes:send through GovernedExternalOperation", () => {
  it("refuses when the durable governed operation is unavailable", async () => {
    assert.equal(createGovernedExternalOperationFromEnv(), null);
    await assert.rejects(
      () =>
        executeGovernedQuoteSend({
          mode: "execute",
          projectId: "project-1",
          actionId: "action-send-1",
          authority: "T2",
        }),
      GovernedQuoteSendUnavailableError,
    );
  });

  it("does not invoke the quote provider when the single-use claim is refused", async () => {
    const harness = seam();
    harness.claims.result = { claimed: false, claimId: "", blockReason: "not-approved" };
    const receipt = await executeGovernedQuoteSend(
      {
        mode: "execute",
        projectId: "project-1",
        actionId: "action-send-1",
        authority: "T2",
      },
      () => harness.gate,
    );
    assert.equal(receipt.status, "blocked");
    assert.equal(receipt.errorCode, "not-authorized");
    assert.equal(receipt.tool, "quotes");
    assert.equal(receipt.operation, "send");
    assert.equal(harness.provider.prepares, 0);
    assert.equal(harness.provider.sends, 0);
    assert.equal(harness.claims.calls, 1);
    assert.equal(harness.executes(), 1);
  });

  it("does not invoke the quote provider when reusable eligibility is refused", async () => {
    const harness = seam(
      approvedQuoteSend({ consumptionPolicy: "reusable", requiredAuthority: "T2" }),
    );
    harness.eligibility.result = { eligible: false, blockReason: "expired" };
    const receipt = await executeGovernedQuoteSend(
      {
        mode: "execute",
        projectId: "project-1",
        actionId: "action-send-1",
        authority: "T2",
      },
      () => harness.gate,
    );
    assert.equal(receipt.status, "blocked");
    assert.equal(receipt.errorCode, "approval-expired");
    assert.equal(harness.provider.sends, 0);
    assert.equal(harness.claims.calls, 0);
    assert.equal(harness.eligibility.calls, 1);
  });

  it("returns the stable indeterminate receipt and does not send again", async () => {
    const harness = seam();
    const receipt = await executeGovernedQuoteSend(
      {
        mode: "execute",
        projectId: "project-1",
        actionId: "action-send-1",
        authority: "T2",
      },
      () => harness.gate,
    );
    assert.equal(receipt.status, "indeterminate");
    assert.equal(receipt.tool, "quotes");
    assert.equal(receipt.operation, "send");
    assert.equal(receipt.provider, PROVIDER_NAME);
    assert.ok(receipt.receiptId);
    assert.equal(harness.provider.prepares, 1);
    assert.equal(harness.provider.sends, 1);
    assert.equal(harness.executes(), 1);
    assert.equal(harness.reconciliations.markCalls.length, 1);
    assert.equal(
      receipt.reconciliationId,
      harness.reconciliations.envelope?.reconciliation.reconciliationId,
    );
    const visible = await harness.reconciliations.getByScope({
      projectId: "project-1",
      tool: "quotes",
      operation: "send",
      idempotencyKey: receipt.idempotencyKey,
      effectFingerprint: receipt.effectFingerprint ?? "",
    });
    assert.equal(visible?.reconciliation.reconciliationId, receipt.reconciliationId);
    assert.equal(visible?.receipt?.status, "indeterminate");
  });

  it("rejects a PolicyEngine allow decision before any provider call", async () => {
    const harness = seam();
    await assert.rejects(
      () =>
        executeGovernedQuoteSend(
          {
            mode: "execute",
            projectId: "project-1",
            actionId: "action-send-1",
            authority: "T2",
            authorityDecision: { allowed: true, reason: "PolicyEngine allow" },
          },
          () => harness.gate,
        ),
      PolicyEngineNotAuthorityError,
    );
    assert.equal(harness.provider.prepares, 0);
    assert.equal(harness.provider.sends, 0);
    assert.equal(harness.claims.calls, 0);
  });

  it("stages quotes:send without approving or calling the provider", async () => {
    const harness = seam();
    const staged = await executeGovernedQuoteSend(
      {
        mode: "propose",
        proposal: {
          actionId: "action-new",
          requestId: "request-new",
          projectId: "project-1",
          expectedRevision: 1,
          tool: "quotes",
          operation: "send",
          arguments: approvedQuoteSend().arguments,
          rationale: "Stage a quote send for owner approval.",
          requiredAuthority: "T2",
          destructive: false,
          idempotencyKey: "proposal-new",
          proposedBy: "agent",
        },
      },
      () => harness.gate,
    );
    assert.equal(staged.state, "proposed");
    assert.equal(staged.approvedBy, undefined);
    assert.equal(harness.provider.sends, 0);
    await assert.rejects(
      () =>
        executeGovernedQuoteSend(
          {
            mode: "execute",
            projectId: "project-1",
            actionId: "action-new",
            authority: "T2",
          },
          () => harness.gate,
        ),
      /does not approve/,
    );
    assert.equal(harness.provider.sends, 0);
    assert.equal(harness.executes(), 0);
  });

  it("refuses to execute a GitHub merge and leaves the mocked merge activity in place", async () => {
    const harness = seam(
      approvedQuoteSend({
        actionId: "merge-action",
        tool: "github",
        operation: "merge-pull-request",
        arguments: { head: "abc" },
      }),
    );
    await assert.rejects(
      () =>
        executeGovernedQuoteSend(
          {
            mode: "execute",
            projectId: "project-1",
            actionId: "merge-action",
            authority: "T3",
          },
          () => harness.gate,
        ),
      GovernedQuoteSendRefused,
    );
    assert.equal(harness.executes(), 0);
    assert.equal(harness.provider.sends, 0);

    const mockRepoPath = path.join(os.tmpdir(), `temporal-pass-mock-repo-${randomUUID()}.json`);
    const idempotencyPath = path.join(
      os.tmpdir(),
      `temporal-pass-idempotency-${randomUUID()}.json`,
    );
    process.env.TEMPORAL_PASS_MOCK_REPO_PATH = mockRepoPath;
    process.env.TEMPORAL_PASS_IDEMPOTENCY_PATH = idempotencyPath;
    const { mergePR } =
      await import("../src/preview/temporalPass/temporal/activities/mockPassActivities.js");
    const { MockRepoStateStore } =
      await import("../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const repo = "repo-merge-stays-mocked";
    await mergePR({
      missionId: "mission-merge-stays-mocked",
      stepId: "merge",
      repo,
      prNumber: 1,
      expectedSha: `seed-${repo}`,
    });
    const state = await new MockRepoStateStore(mockRepoPath).get(repo);
    assert.equal(state.isMerged, true);
    assert.equal(state.mergeEffectCount, 1);
    assert.equal(harness.provider.sends, 0);
  });
});
