import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolExecutionReceipt } from "../src/actions/toolExecution.js";
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
import { runExternalReconciliationSmoke } from "../src/tools/externalReconciliationSmoke.js";

type Backend = {
  reconciliation: ExternalReconciliationRecord | null;
  receipt: ToolExecutionReceipt | null;
  cleanupCalls: number;
  resolveCalls: number;
  failClaim: boolean;
};

function backend(): Backend {
  return {
    reconciliation: null,
    receipt: null,
    cleanupCalls: 0,
    resolveCalls: 0,
    failClaim: false,
  };
}

class SharedFakeReconciliationStore implements ExternalReconciliationStore {
  constructor(private readonly backend: Backend) {}

  async getByScope(scope: ExternalExecutionScope): Promise<ExternalReconciliationEnvelope | null> {
    const record = this.backend.reconciliation;
    if (
      !record ||
      record.projectId !== scope.projectId ||
      record.tool !== scope.tool ||
      record.operation !== scope.operation ||
      record.idempotencyKey !== scope.idempotencyKey ||
      record.effectFingerprint !== scope.effectFingerprint
    ) {
      return null;
    }
    return { reconciliation: record, receipt: this.backend.receipt };
  }

  async registerAttempt(
    input: RegisterExternalAttemptInput,
  ): Promise<ExternalReconciliationRecord> {
    if (this.backend.reconciliation) return this.backend.reconciliation;
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
    this.backend.reconciliation = record;
    return record;
  }

  async markIndeterminate(
    input: MarkExternalIndeterminateInput,
  ): Promise<ExternalReconciliationEnvelope> {
    const current = this.backend.reconciliation;
    if (!current) throw new Error("attempt must be registered first");
    const updated: ExternalReconciliationRecord = {
      ...current,
      receiptKey: input.receiptKey,
      receiptId: input.receipt.receiptId,
      state: "pending",
      nextAttemptAt: Date.now(),
      updatedAt: Date.now(),
    };
    const receipt: ToolExecutionReceipt = {
      ...input.receipt,
      effectFingerprint: input.effectFingerprint,
      provider: current.provider,
      providerRequestId: current.providerRequestId,
      providerCorrelationId: current.providerCorrelationId,
      reconciliationId: current.reconciliationId,
      status: "indeterminate",
      errorCode: "indeterminate",
    };
    this.backend.reconciliation = updated;
    this.backend.receipt = receipt;
    return { reconciliation: updated, receipt };
  }

  async completeAttempt(
    _input: CompleteExternalAttemptInput,
  ): Promise<ExternalReconciliationEnvelope> {
    throw new Error("not used by smoke");
  }

  async claimNext(input: {
    workerId: string;
    leaseToken: string;
    now: number;
    leaseMs: number;
  }): Promise<ExternalReconciliationClaim | null> {
    if (this.backend.failClaim) throw new Error("injected claim failure");
    const current = this.backend.reconciliation;
    const receipt = this.backend.receipt;
    if (!current || !receipt || current.state !== "pending") return null;
    const claimed: ExternalReconciliationClaim["reconciliation"] = {
      ...current,
      state: "claimed",
      attemptCount: current.attemptCount + 1,
      leaseOwner: input.workerId,
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.now + input.leaseMs,
      updatedAt: input.now,
    };
    this.backend.reconciliation = claimed;
    return { reconciliation: claimed, receipt };
  }

  async resolveClaim(input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    result: Exclude<ProviderReconciliationResult, { status: "unresolved" }>;
  }): Promise<ToolExecutionReceipt> {
    const current = this.backend.reconciliation;
    const receipt = this.backend.receipt;
    if (
      !current ||
      !receipt ||
      current.reconciliationId !== input.reconciliationId ||
      current.leaseOwner !== input.workerId ||
      current.leaseToken !== input.leaseToken
    ) {
      throw new Error("invalid reconciliation claim");
    }
    this.backend.resolveCalls += 1;
    const terminalReceipt: ToolExecutionReceipt = {
      ...receipt,
      status: input.result.status === "succeeded" ? "succeeded" : "failed",
      ...(input.result.status === "succeeded" && input.result.outputDigest
        ? { outputDigest: input.result.outputDigest }
        : {}),
      ...(input.result.status === "failed"
        ? { errorCode: "provider-failed" as const, providerErrorCode: input.result.errorCode }
        : { errorCode: undefined }),
      completedAt: new Date(input.now).toISOString(),
    };
    const resolved: ExternalReconciliationRecord = {
      ...current,
      state: "resolved",
      terminalStatus: input.result.status,
      ...(input.result.status === "succeeded" && input.result.outputDigest
        ? { resolutionDigest: input.result.outputDigest }
        : {}),
      ...(input.result.status === "failed" ? { resolutionErrorCode: input.result.errorCode } : {}),
      updatedAt: input.now,
      resolvedAt: input.now,
    };
    this.backend.receipt = terminalReceipt;
    this.backend.reconciliation = resolved;
    return terminalReceipt;
  }

  async releaseClaim(input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    errorCode: string;
    nextAttemptAt: number;
    maxAttempts: number;
  }): Promise<ExternalReconciliationRecord> {
    const current = this.backend.reconciliation;
    if (!current) throw new Error("missing reconciliation");
    const escalated = current.attemptCount >= input.maxAttempts;
    const updated: ExternalReconciliationRecord = {
      ...current,
      state: escalated ? "escalated" : "pending",
      nextAttemptAt: input.nextAttemptAt,
      lastErrorCode: input.errorCode,
      ...(escalated ? { escalationReason: input.errorCode, escalatedAt: input.now } : {}),
      updatedAt: input.now,
    };
    this.backend.reconciliation = updated;
    return updated;
  }

  async cleanup(reconciliationId: string): Promise<boolean> {
    this.backend.cleanupCalls += 1;
    if (this.backend.reconciliation?.reconciliationId !== reconciliationId) return false;
    this.backend.reconciliation = null;
    this.backend.receipt = null;
    return true;
  }
}

describe("runExternalReconciliationSmoke", () => {
  it("refuses non-development deployments before constructing a store", async () => {
    let constructions = 0;

    await assert.rejects(
      runExternalReconciliationSmoke(() => {
        constructions += 1;
        return new SharedFakeReconciliationStore(backend());
      }, "prod:jarvis"),
      /must identify a development deployment/,
    );

    assert.equal(constructions, 0);
  });

  it("recovers from a fresh store instance, resolves once, and cleans all synthetic state", async () => {
    const shared = backend();
    let constructions = 0;
    const messages: string[] = [];

    const result = await runExternalReconciliationSmoke(
      () => {
        constructions += 1;
        return new SharedFakeReconciliationStore(shared);
      },
      "dev:outgoing-ram-798",
      (message) => messages.push(message),
    );

    assert.deepEqual(result, {
      attemptRegistered: true,
      indeterminatePersisted: true,
      restartClaimed: true,
      providerResolved: true,
      authoritativeReceiptVerified: true,
      cleaned: true,
    });
    assert.ok(constructions >= 5, "smoke must use fresh store instances across lifecycle steps");
    assert.equal(shared.resolveCalls, 1);
    assert.equal(shared.cleanupCalls, 1);
    assert.equal(shared.reconciliation, null);
    assert.equal(shared.receipt, null);
    assert.equal(messages.length, 1);
  });

  it("cleans synthetic reconciliation state after an injected claim failure", async () => {
    const shared = backend();
    shared.failClaim = true;

    await assert.rejects(
      runExternalReconciliationSmoke(
        () => new SharedFakeReconciliationStore(shared),
        "dev:outgoing-ram-798",
      ),
      /injected claim failure/,
    );

    assert.equal(shared.cleanupCalls, 1);
    assert.equal(shared.reconciliation, null);
    assert.equal(shared.receipt, null);
  });
});
