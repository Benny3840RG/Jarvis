import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Context } from "@temporalio/activity";

import { GovernedExternalOperation } from "../../../../actions/governedExternalOperation.js";
import { createQuoteSendToolDefinition } from "../../../../actions/quoteSendTool.js";
import type { ToolAction, ToolActionService } from "../../../../actions/toolActions.js";
import {
  ToolExecutionService,
  type ExecutionEligibilityResult,
  type ExecutionEligibilityStore,
  type SingleUseConsumptionClaimStore,
  type SingleUseExecutionClaimResult,
  type ToolExecutionReceipt,
  type ToolExecutionReceiptStore,
} from "../../../../actions/toolExecution.js";
import { writePrivateJsonFile } from "../../../../persistence/atomicJsonFile.js";
import { JsonFileLock } from "../../../../persistence/jsonFileLock.js";
import type {
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
} from "../../../../quotes/quoteDeliveryRepository.js";
import type {
  QuoteEmailPrepareInput,
  QuoteEmailPreparedReference,
  QuoteEmailProvider,
  QuoteEmailSendAcceptance,
} from "../../../../quotes/quoteEmailProvider.js";
import type { QuoteSnapshot } from "../../../../quotes/quoteLifecycle.js";
import type { QuotePdfArtifactRepository } from "../../../../quotes/quotePdfArtifactRepository.js";
import type { QuoteRepository, QuoteSummary } from "../../../../quotes/quoteRepository.js";
import type {
  CompleteExternalAttemptInput,
  ExternalExecutionScope,
  ExternalReconciliationClaim,
  ExternalReconciliationEnvelope,
  ExternalReconciliationRecord,
  ExternalReconciliationStore,
  MarkExternalIndeterminateInput,
  RegisterExternalAttemptInput,
} from "../../../../reconciliation/externalReconciliation.js";
import type { GovernedQuoteSendGate } from "./governedQuoteSend.js";

/**
 * Test-only seam. `createGovernedExternalOperationFromEnv()` is null on JSON
 * persistence, and an in-memory Convex test dies with the worker process.
 * This directory holds the claim, receipt, and reconciliation records the
 * stable boundary writes, so a SIGKILL after provider accept can be retried
 * by a new process. It is not a second approval store and it never calls
 * Microsoft Graph.
 */
export const GOVERNED_QUOTE_SEND_DIR_ENV = "TEMPORAL_PASS_GOVERNED_QUOTE_SEND_DIR";
export const GOVERNED_QUOTE_SEND_ACCEPT_DELAY_ENV = "TEMPORAL_PASS_QUOTE_SEND_ACCEPT_DELAY_MS";

const PROVIDER_NAME = "microsoft-graph-mail-connections-v1";
const REVISION_FINGERPRINT = "quote-revision:v1:sha256:aaaa";

export function approvedQuoteSendFixture(actionId = "action-send-1"): ToolAction {
  return {
    actionId,
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
  };
}

type ProviderCounts = { prepares: number; sends: number };
type ActionFile = Record<string, ToolAction>;
type ClaimFile = Record<string, string>;
type ReconciliationFile = { envelopes: ExternalReconciliationEnvelope[] };
type DeliveryFile = { attempts: QuoteDeliveryAttempt[] };
type ReceiptFile = Record<string, ToolExecutionReceipt>;

export type GovernedQuoteSendEvidence = {
  prepares: number;
  sends: number;
  envelope: ExternalReconciliationEnvelope | null;
};

class JsonDocument<T> {
  private readonly lock: JsonFileLock;

  constructor(
    private readonly filePath: string,
    private readonly empty: T,
  ) {
    this.lock = new JsonFileLock(filePath, (message) => console.warn(message), 2_000);
  }

  async read(): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return this.empty;
      throw new Error(`Governed quote-send file ${this.filePath} could not be read.`, {
        cause: error,
      });
    }
  }

  async update(mutate: (current: T) => T | Promise<T>): Promise<T> {
    return this.lock.run(
      async () => {
        const current = await this.read();
        const next = await mutate(current);
        await writePrivateJsonFile(this.filePath, next);
        return next;
      },
      `governed quote-send write ${path.basename(this.filePath)}`,
    );
  }
}

function files(directory: string) {
  return {
    actions: new JsonDocument<ActionFile>(path.join(directory, "actions.json"), {}),
    claims: new JsonDocument<ClaimFile>(path.join(directory, "claims.json"), {}),
    reconciliations: new JsonDocument<ReconciliationFile>(
      path.join(directory, "reconciliations.json"),
      { envelopes: [] },
    ),
    deliveries: new JsonDocument<DeliveryFile>(path.join(directory, "deliveries.json"), {
      attempts: [],
    }),
    receipts: new JsonDocument<ReceiptFile>(path.join(directory, "receipts.json"), {}),
    provider: new JsonDocument<ProviderCounts>(path.join(directory, "provider.json"), {
      prepares: 0,
      sends: 0,
    }),
  };
}

function sameScope(record: ExternalReconciliationRecord, scope: ExternalExecutionScope): boolean {
  return (
    record.projectId === scope.projectId &&
    record.tool === scope.tool &&
    record.operation === scope.operation &&
    record.idempotencyKey === scope.idempotencyKey &&
    record.effectFingerprint === scope.effectFingerprint
  );
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

function quoteRepository(): QuoteRepository {
  const current = snapshot();
  const unused = async (): Promise<never> => {
    throw new Error("Unused quote repository method.");
  };
  return {
    createQuote: unused,
    async getQuote(quoteId: string): Promise<QuoteSnapshot | null> {
      return current.aggregate.quoteId === quoteId ? current : null;
    },
    listQuotes: async (): Promise<QuoteSummary[]> => {
      throw new Error("Unused quote repository method.");
    },
    updateDraft: unused,
    submitForReview: unused,
    reopenForEditing: unused,
    finalizeRevision: unused,
    createRevisionFromFinalized: unused,
    recordCommercialOutcome: unused,
    cleanup: async () => false,
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

class CountingFileProvider implements QuoteEmailProvider {
  readonly name = PROVIDER_NAME;

  constructor(private readonly counts: JsonDocument<ProviderCounts>) {}

  async prepare(input: QuoteEmailPrepareInput): Promise<QuoteEmailPreparedReference> {
    if (input.recipient !== "client@example.com") {
      throw new Error("quote-send fixture recipient mismatch");
    }
    await this.counts.update((current) => ({ ...current, prepares: current.prepares + 1 }));
    return {
      providerRequestId: "graph-draft-1",
      providerCorrelationId: "graph-correlation-1",
    };
  }

  async sendPrepared(): Promise<QuoteEmailSendAcceptance> {
    await this.counts.update((current) => ({ ...current, sends: current.sends + 1 }));
    const delay = Number(process.env[GOVERNED_QUOTE_SEND_ACCEPT_DELAY_ENV] ?? "0");
    if (Number.isFinite(delay) && delay > 0) {
      const heartbeatStepMs = 250;
      const activity = Context.current();
      for (let elapsed = 0; elapsed < delay; elapsed += heartbeatStepMs) {
        await sleep(Math.min(heartbeatStepMs, delay - elapsed));
        activity.heartbeat();
      }
    }
    return { status: "accepted" };
  }
}

class FileActions implements Pick<ToolActionService, "stage" | "get"> {
  constructor(private readonly document: JsonDocument<ActionFile>) {}

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
    await this.document.update((current) => ({ ...current, [staged.actionId]: staged }));
    return staged;
  }

  async get(input: { actionId: string; projectId: string }): Promise<ToolAction | null> {
    const row = (await this.document.read())[input.actionId];
    if (!row || row.projectId !== input.projectId) return null;
    return row;
  }
}

class FileClaims implements SingleUseConsumptionClaimStore {
  constructor(
    private readonly claims: JsonDocument<ClaimFile>,
    private readonly actions: JsonDocument<ActionFile>,
  ) {}

  async claim(action: ToolAction, claimId: string): Promise<SingleUseExecutionClaimResult> {
    const stored = (await this.actions.read())[action.actionId];
    if (!stored || stored.state !== "approved") {
      return { claimed: false, claimId: "", blockReason: "not-approved" };
    }
    if (stored.isApprovalExpired) {
      return { claimed: false, claimId: "", blockReason: "expired" };
    }
    let result: SingleUseExecutionClaimResult = { claimed: true, claimId };
    await this.claims.update((current) => {
      const existing = current[action.actionId];
      if (existing) {
        result = { claimed: false, claimId: existing, blockReason: "already-claimed" };
        return current;
      }
      return { ...current, [action.actionId]: claimId };
    });
    return result;
  }
}

class FileEligibility implements ExecutionEligibilityStore {
  constructor(private readonly actions: JsonDocument<ActionFile>) {}

  async verify(action: ToolAction): Promise<ExecutionEligibilityResult> {
    const stored = (await this.actions.read())[action.actionId];
    if (!stored || stored.state !== "approved") {
      return { eligible: false, blockReason: "not-approved" };
    }
    if (stored.isApprovalExpired) return { eligible: false, blockReason: "expired" };
    return { eligible: true };
  }
}

class FileReceipts implements ToolExecutionReceiptStore {
  constructor(private readonly document: JsonDocument<ReceiptFile>) {}

  async get(key: string): Promise<ToolExecutionReceipt | null> {
    return (await this.document.read())[key] ?? null;
  }

  async save(key: string, receipt: ToolExecutionReceipt): Promise<void> {
    await this.document.update((current) => ({ ...current, [key]: receipt }));
  }
}

class FileDeliveries implements QuoteDeliveryRepository {
  constructor(private readonly document: JsonDocument<DeliveryFile>) {}

  async getBySendScope(
    input: Parameters<QuoteDeliveryRepository["getBySendScope"]>[0],
  ): Promise<QuoteDeliveryAttempt | null> {
    const { attempts } = await this.document.read();
    return (
      attempts.find(
        (attempt) =>
          attempt.quoteId === input.quoteId &&
          attempt.revision === input.revision &&
          attempt.recipient === input.recipient &&
          attempt.channel === input.channel,
      ) ?? null
    );
  }

  async createPending(
    input: Parameters<QuoteDeliveryRepository["createPending"]>[0],
  ): Promise<QuoteDeliveryAttempt> {
    const attempt: QuoteDeliveryAttempt = {
      ...input,
      deliveryAttemptId: "delivery-1",
      ownerId: "owner-1",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    };
    await this.document.update((current) => ({ attempts: [...current.attempts, attempt] }));
    return attempt;
  }

  async markExecuting(
    input: Parameters<QuoteDeliveryRepository["markExecuting"]>[0],
  ): Promise<QuoteDeliveryAttempt> {
    return this.patch(input.deliveryAttemptId, { status: "executing", executionStartedAt: 2 });
  }

  async bindProviderReference(
    input: Parameters<QuoteDeliveryRepository["bindProviderReference"]>[0],
  ): Promise<QuoteDeliveryAttempt> {
    return this.patch(input.deliveryAttemptId, {
      providerRequestId: input.providerRequestId,
      providerCorrelationId: input.providerCorrelationId,
      reconciliationId: input.reconciliationId,
    });
  }

  async complete(): Promise<QuoteDeliveryAttempt> {
    throw new Error("complete is not used by the indeterminate quote-send path");
  }

  async markIndeterminate(
    input: Parameters<QuoteDeliveryRepository["markIndeterminate"]>[0],
  ): Promise<QuoteDeliveryAttempt> {
    return this.patch(input.deliveryAttemptId, {
      status: "indeterminate",
      reconciliationId: input.reconciliationId,
    });
  }

  async reconcile(): Promise<QuoteDeliveryAttempt> {
    throw new Error("reconcile is not used");
  }

  async listForQuote(): Promise<QuoteDeliveryAttempt[]> {
    return (await this.document.read()).attempts;
  }

  async cleanup(): Promise<boolean> {
    return false;
  }

  private async patch(
    deliveryAttemptId: string,
    patch: Partial<QuoteDeliveryAttempt>,
  ): Promise<QuoteDeliveryAttempt> {
    let updated: QuoteDeliveryAttempt | undefined;
    await this.document.update((current) => ({
      attempts: current.attempts.map((attempt) => {
        if (attempt.deliveryAttemptId !== deliveryAttemptId) return attempt;
        updated = { ...attempt, ...patch, updatedAt: attempt.updatedAt + 1 };
        return updated;
      }),
    }));
    if (!updated) throw new Error(`Missing quote delivery ${deliveryAttemptId}.`);
    return updated;
  }
}

class FileReconciliations implements ExternalReconciliationStore {
  constructor(private readonly document: JsonDocument<ReconciliationFile>) {}

  async getByScope(scope: ExternalExecutionScope): Promise<ExternalReconciliationEnvelope | null> {
    const { envelopes } = await this.document.read();
    return envelopes.find((envelope) => sameScope(envelope.reconciliation, scope)) ?? null;
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
      ...(input.safetyBinding === undefined ? {} : { safetyBinding: input.safetyBinding }),
    };
    await this.document.update((current) => {
      if (current.envelopes.some((envelope) => sameScope(envelope.reconciliation, input))) {
        return current;
      }
      return { envelopes: [...current.envelopes, { reconciliation: record, receipt: null }] };
    });
    return record;
  }

  async markIndeterminate(
    input: MarkExternalIndeterminateInput,
  ): Promise<ExternalReconciliationEnvelope> {
    const now = Date.now();
    let stored: ExternalReconciliationEnvelope | undefined;
    await this.document.update((current) => ({
      envelopes: current.envelopes.map((envelope) => {
        if (envelope.reconciliation.reconciliationId !== input.reconciliationId) return envelope;
        const currentRecord = envelope.reconciliation;
        const record: ExternalReconciliationRecord = {
          ...currentRecord,
          provider: input.expectedProvider,
          receiptKey: input.receiptKey,
          receiptId: input.receipt.receiptId,
          state: currentRecord.providerRequestId ? "pending" : "escalated",
          updatedAt: now,
        };
        const receipt: ToolExecutionReceipt = {
          ...input.receipt,
          reconciliationId: record.reconciliationId,
          ...(record.providerRequestId === undefined
            ? {}
            : { providerRequestId: record.providerRequestId }),
          providerCorrelationId: record.providerCorrelationId,
        };
        stored = { reconciliation: record, receipt };
        return stored;
      }),
    }));
    if (!stored) throw new Error(`Missing reconciliation ${input.reconciliationId}.`);
    return stored;
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

export async function seedApprovedQuoteSend(
  directory: string,
  action: ToolAction = approvedQuoteSendFixture(),
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await writePrivateJsonFile(path.join(directory, "actions.json"), {
    [action.actionId]: action,
  });
}

export async function readGovernedQuoteSendEvidence(
  directory: string,
): Promise<GovernedQuoteSendEvidence> {
  const store = files(directory);
  const counts = await store.provider.read();
  const { envelopes } = await store.reconciliations.read();
  return {
    prepares: counts.prepares,
    sends: counts.sends,
    envelope: envelopes[0] ?? null,
  };
}

export function loadFileBackedGovernedQuoteSendGate(directory: string): GovernedQuoteSendGate {
  const store = files(directory);
  const actions = new FileActions(store.actions);
  const reconciliations = new FileReconciliations(store.reconciliations);
  const execution = new ToolExecutionService(
    [
      createQuoteSendToolDefinition(
        quoteRepository(),
        new CountingFileProvider(store.provider),
        new FileDeliveries(store.deliveries),
        pdfArtifacts(),
      ),
    ],
    new FileReceipts(store.receipts),
    reconciliations,
    new FileClaims(store.claims, store.actions),
    new FileEligibility(store.actions),
  );
  const operation = new GovernedExternalOperation({
    actions,
    execution,
    reconciliations,
  });
  return {
    propose: (input) => operation.propose(input),
    execute: (input) => operation.execute(input),
    getAction: (input) => actions.get(input),
  };
}
