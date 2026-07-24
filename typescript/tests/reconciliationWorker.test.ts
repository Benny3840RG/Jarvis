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
  ProviderReconciliationAdapter,
  ProviderReconciliationResult,
  RegisterExternalAttemptInput,
} from "../src/reconciliation/externalReconciliation.js";
import {
  ProviderAdapterRegistry,
  ReconciliationWorker,
} from "../src/reconciliation/reconciliationWorker.js";

const NOW = 1_785_000_000_000;

function receipt(
  status: ToolExecutionReceipt["status"] = "indeterminate",
): ToolExecutionReceipt {
  return {
    receiptId: "receipt-1",
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    idempotencyKey: "external-1",
    actionFingerprint: "jarvis-action-fingerprint:v1:action",
    effectFingerprint: "jarvis-effect-fingerprint:v1:effect",
    tool: "quotes",
    operation: "send",
    actor: "agent",
    policyVersion: "totality-policy:v1",
    correlationId: "correlation-1",
    source: "test",
    provider: "demo-provider",
    providerRequestId: "provider-request-1",
    providerCorrelationId: "provider-correlation-1",
    reconciliationId: "reconciliation-1",
    status,
    ...(status === "indeterminate" ? { errorCode: "indeterminate" as const } : {}),
    startedAt: new Date(NOW - 1_000).toISOString(),
    completedAt: new Date(NOW).toISOString(),
  };
}

function record(
  overrides: Partial<ExternalReconciliationRecord> = {},
): ExternalReconciliationRecord {
  return {
    reconciliationId: "reconciliation-1",
    executionKey: "project-1:action-1:external-1",
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    tool: "quotes",
    operation: "send",
    idempotencyKey: "external-1",
    actionFingerprint: "jarvis-action-fingerprint:v1:action",
    effectFingerprint: "jarvis-effect-fingerprint:v1:effect",
    provider: "demo-provider",
    providerRequestId: "provider-request-1",
    providerCorrelationId: "provider-correlation-1",
    receiptKey: "project-1:action-1:external-1",
    receiptId: "receipt-1",
    state: "claimed",
    attemptCount: 1,
    nextAttemptAt: NOW,
    leaseOwner: "worker-1",
    leaseToken: "lease-1",
    leaseExpiresAt: NOW + 5_000,
    createdAt: NOW - 2_000,
    updatedAt: NOW,
    ...overrides,
  };
}

function claim(
  overrides: Partial<ExternalReconciliationRecord> = {},
): ExternalReconciliationClaim {
  return {
    reconciliation: record(overrides) as ExternalReconciliationClaim["reconciliation"],
    receipt: receipt(),
  };
}

class FakeStore implements ExternalReconciliationStore {
  private availableClaim: ExternalReconciliationClaim | null;
  readonly claimCalls: Array<{
    workerId: string;
    leaseToken: string;
    now: number;
    leaseMs: number;
  }> = [];
  readonly resolveCalls: Array<{
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    result: Exclude<ProviderReconciliationResult, { status: "unresolved" }>;
  }> = [];
  readonly releaseCalls: Array<{
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    errorCode: string;
    nextAttemptAt: number;
    maxAttempts: number;
  }> = [];

  constructor(initialClaim: ExternalReconciliationClaim | null = claim()) {
    this.availableClaim = initialClaim;
  }

  async getByScope(
    _scope: ExternalExecutionScope,
  ): Promise<ExternalReconciliationEnvelope | null> {
    return null;
  }

  async registerAttempt(
    _input: RegisterExternalAttemptInput,
  ): Promise<ExternalReconciliationRecord> {
    throw new Error("not used");
  }

  async markIndeterminate(
    _input: MarkExternalIndeterminateInput,
  ): Promise<ExternalReconciliationEnvelope> {
    throw new Error("not used");
  }

  async completeAttempt(
    _input: CompleteExternalAttemptInput,
  ): Promise<ExternalReconciliationEnvelope> {
    throw new Error("not used");
  }

  async claimNext(input: {
    workerId: string;
    leaseToken: string;
    now: number;
    leaseMs: number;
  }): Promise<ExternalReconciliationClaim | null> {
    this.claimCalls.push(input);
    const next = this.availableClaim;
    this.availableClaim = null;
    if (!next) return null;
    return {
      ...next,
      reconciliation: {
        ...next.reconciliation,
        leaseOwner: input.workerId,
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.now + input.leaseMs,
      },
    };
  }

  async resolveClaim(input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    result: Exclude<ProviderReconciliationResult, { status: "unresolved" }>;
  }): Promise<ToolExecutionReceipt> {
    this.resolveCalls.push(input);
    return receipt(input.result.status);
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
    this.releaseCalls.push(input);
    const current = record({
      reconciliationId: input.reconciliationId,
      leaseOwner: input.workerId,
      leaseToken: input.leaseToken,
    });
    const escalated = current.attemptCount >= input.maxAttempts;
    return {
      ...current,
      state: escalated ? "escalated" : "pending",
      nextAttemptAt: input.nextAttemptAt,
      lastErrorCode: input.errorCode,
      ...(escalated
        ? { escalationReason: input.errorCode, escalatedAt: input.now }
        : {}),
      updatedAt: input.now,
    };
  }

  async cleanup(_reconciliationId: string): Promise<boolean> {
    return true;
  }
}

function adapter(
  provider: string,
  result: ProviderReconciliationResult,
  calls: Array<{ providerRequestId: string; providerCorrelationId: string }> = [],
): ProviderReconciliationAdapter {
  return {
    provider,
    async reconcile(reference) {
      calls.push({
        providerRequestId: reference.providerRequestId,
        providerCorrelationId: reference.providerCorrelationId,
      });
      return result;
    },
  };
}

describe("ReconciliationWorker", () => {
  it("rejects duplicate provider adapter registrations", () => {
    assert.throws(
      () =>
        new ProviderAdapterRegistry([
          adapter("demo-provider", { status: "succeeded" }),
          adapter("demo-provider", { status: "failed", errorCode: "duplicate" }),
        ]),
      /Duplicate provider reconciliation adapter: demo-provider/,
    );
  });

  it("claims one record and resolves a proven provider success exactly once", async () => {
    const store = new FakeStore();
    const providerCalls: Array<{
      providerRequestId: string;
      providerCorrelationId: string;
    }> = [];
    const worker = new ReconciliationWorker({
      store,
      adapters: [
        adapter(
          "demo-provider",
          { status: "succeeded", outputDigest: "digest-1" },
          providerCalls,
        ),
      ],
      now: () => NOW,
      leaseToken: () => "lease-generated",
    });

    const result = await worker.runOnce({
      workerId: "worker-1",
      leaseMs: 5_000,
      signal: new AbortController().signal,
    });

    assert.deepEqual(result, {
      status: "resolved",
      reconciliationId: "reconciliation-1",
      terminalStatus: "succeeded",
    });
    assert.deepEqual(providerCalls, [
      {
        providerRequestId: "provider-request-1",
        providerCorrelationId: "provider-correlation-1",
      },
    ]);
    assert.equal(store.resolveCalls.length, 1);
    assert.equal(store.releaseCalls.length, 0);
  });

  it("releases unresolved provider status with bounded retry timing", async () => {
    const store = new FakeStore();
    const worker = new ReconciliationWorker({
      store,
      adapters: [
        adapter("demo-provider", {
          status: "unresolved",
          errorCode: "provider-still-processing",
          retryAfterMs: 2_500,
        }),
      ],
      now: () => NOW,
      leaseToken: () => "lease-generated",
      maxAttempts: 3,
      baseRetryMs: 1_000,
      maxRetryMs: 10_000,
    });

    const result = await worker.runOnce({
      workerId: "worker-1",
      leaseMs: 5_000,
      signal: new AbortController().signal,
    });

    assert.deepEqual(result, {
      status: "released",
      reconciliationId: "reconciliation-1",
      nextAttemptAt: NOW + 2_500,
    });
    assert.equal(store.resolveCalls.length, 0);
    assert.deepEqual(store.releaseCalls, [
      {
        reconciliationId: "reconciliation-1",
        workerId: "worker-1",
        leaseToken: "lease-generated",
        now: NOW,
        errorCode: "provider-still-processing",
        nextAttemptAt: NOW + 2_500,
        maxAttempts: 3,
      },
    ]);
  });

  it("escalates an unknown provider without attempting the external effect", async () => {
    const store = new FakeStore(claim({ provider: "unregistered-provider" }));
    const worker = new ReconciliationWorker({
      store,
      adapters: [],
      now: () => NOW,
      leaseToken: () => "lease-generated",
      maxAttempts: 5,
    });

    const result = await worker.runOnce({
      workerId: "worker-1",
      leaseMs: 5_000,
      signal: new AbortController().signal,
    });

    assert.deepEqual(result, {
      status: "escalated",
      reconciliationId: "reconciliation-1",
      reason: "unknown-provider:unregistered-provider",
    });
    assert.equal(store.resolveCalls.length, 0);
    assert.equal(store.releaseCalls.length, 1);
    assert.equal(store.releaseCalls[0]?.maxAttempts, 1);
  });

  it("allows concurrent workers to produce only one claim and one terminal resolution", async () => {
    const store = new FakeStore();
    const providerCalls: Array<{
      providerRequestId: string;
      providerCorrelationId: string;
    }> = [];
    const worker = new ReconciliationWorker({
      store,
      adapters: [adapter("demo-provider", { status: "succeeded" }, providerCalls)],
      now: () => NOW,
      leaseToken: (() => {
        let value = 0;
        return () => `lease-${++value}`;
      })(),
    });

    const signal = new AbortController().signal;
    const results = await Promise.all([
      worker.runOnce({ workerId: "worker-1", leaseMs: 5_000, signal }),
      worker.runOnce({ workerId: "worker-2", leaseMs: 5_000, signal }),
    ]);

    assert.equal(
      results.filter(({ status }) => status === "resolved").length,
      1,
    );
    assert.equal(
      results.filter(({ status }) => status === "idle").length,
      1,
    );
    assert.equal(providerCalls.length, 1);
    assert.equal(store.resolveCalls.length, 1);
  });
});
