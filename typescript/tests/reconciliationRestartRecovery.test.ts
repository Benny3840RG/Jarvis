import assert from "node:assert/strict";
import { it } from "node:test";

import type { ToolExecutionReceipt } from "../src/actions/toolExecution.js";
import type {
  ExternalReconciliationClaim,
  ExternalReconciliationStore,
} from "../src/reconciliation/externalReconciliation.js";
import { ReconciliationWorker } from "../src/reconciliation/reconciliationWorker.js";

it("allows a fresh worker process to reclaim and resolve an expired lease", async () => {
  const now = 1_785_000_000_000;
  const receipt: ToolExecutionReceipt = {
    receiptId: "receipt-restart",
    actionId: "action-restart",
    requestId: "request-restart",
    projectId: "project-restart",
    idempotencyKey: "idempotency-restart",
    actionFingerprint: "jarvis-action-fingerprint:v1:restart",
    effectFingerprint: "jarvis-effect-fingerprint:v1:restart",
    tool: "quotes",
    operation: "send",
    actor: "agent",
    policyVersion: "totality-policy:v1",
    correlationId: "correlation-restart",
    source: "test",
    provider: "demo-provider",
    providerRequestId: "provider-request-restart",
    providerCorrelationId: "provider-correlation-restart",
    reconciliationId: "reconciliation-restart",
    status: "indeterminate",
    errorCode: "indeterminate",
    startedAt: new Date(now - 10_000).toISOString(),
    completedAt: new Date(now - 9_000).toISOString(),
  };
  let claimCalls = 0;
  const resolveCalls: unknown[] = [];
  const store = {
    async claimNext(input: {
      workerId: string;
      leaseToken: string;
      now: number;
      leaseMs: number;
    }): Promise<ExternalReconciliationClaim | null> {
      claimCalls += 1;
      if (claimCalls > 1) return null;
      return {
        reconciliation: {
          reconciliationId: "reconciliation-restart",
          executionKey: "external:restart",
          actionId: "action-restart",
          requestId: "request-restart",
          projectId: "project-restart",
          tool: "quotes",
          operation: "send",
          idempotencyKey: "idempotency-restart",
          actionFingerprint: "jarvis-action-fingerprint:v1:restart",
          effectFingerprint: "jarvis-effect-fingerprint:v1:restart",
          provider: "demo-provider",
          providerRequestId: "provider-request-restart",
          providerCorrelationId: "provider-correlation-restart",
          receiptKey: "external:restart",
          receiptId: "receipt-restart",
          state: "claimed",
          attemptCount: 2,
          nextAttemptAt: now - 5_000,
          leaseOwner: input.workerId,
          leaseToken: input.leaseToken,
          leaseExpiresAt: input.now + input.leaseMs,
          createdAt: now - 20_000,
          updatedAt: input.now,
        },
        receipt,
      };
    },
    async resolveClaim(input: unknown): Promise<ToolExecutionReceipt> {
      resolveCalls.push(input);
      return { ...receipt, status: "succeeded", errorCode: undefined };
    },
  } as unknown as ExternalReconciliationStore;

  const restartedWorker = new ReconciliationWorker({
    store,
    adapters: [
      {
        provider: "demo-provider",
        async reconcile() {
          return { status: "succeeded" as const, outputDigest: "restart-digest" };
        },
      },
    ],
    now: () => now,
    leaseToken: () => "fresh-process-lease",
  });

  const result = await restartedWorker.runOnce({
    workerId: "worker-after-restart",
    leaseMs: 30_000,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    status: "resolved",
    reconciliationId: "reconciliation-restart",
    terminalStatus: "succeeded",
  });
  assert.equal(claimCalls, 1);
  assert.deepEqual(resolveCalls, [
    {
      reconciliationId: "reconciliation-restart",
      workerId: "worker-after-restart",
      leaseToken: "fresh-process-lease",
      now,
      result: { status: "succeeded", outputDigest: "restart-digest" },
    },
  ]);
});
