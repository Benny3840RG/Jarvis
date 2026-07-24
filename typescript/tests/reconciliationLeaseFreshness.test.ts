import assert from "node:assert/strict";
import { it } from "node:test";

import type { ToolExecutionReceipt } from "../src/actions/toolExecution.js";
import type {
  ExternalReconciliationClaim,
  ExternalReconciliationStore,
} from "../src/reconciliation/externalReconciliation.js";
import { ReconciliationWorker } from "../src/reconciliation/reconciliationWorker.js";

it("uses the post-provider timestamp when resolving a claimed reconciliation", async () => {
  const claimTime = 1_000;
  const completionTime = 7_000;
  const leaseMs = 5_000;
  const receipt: ToolExecutionReceipt = {
    receiptId: "receipt-freshness",
    actionId: "action-freshness",
    requestId: "request-freshness",
    projectId: "project-freshness",
    idempotencyKey: "idempotency-freshness",
    actionFingerprint: "jarvis-action-fingerprint:v1:freshness",
    effectFingerprint: "jarvis-effect-fingerprint:v1:freshness",
    tool: "quotes",
    operation: "send",
    actor: "agent",
    policyVersion: "totality-policy:v1",
    correlationId: "correlation-freshness",
    source: "test",
    provider: "demo-provider",
    providerRequestId: "provider-request-freshness",
    providerCorrelationId: "provider-correlation-freshness",
    reconciliationId: "reconciliation-freshness",
    status: "indeterminate",
    errorCode: "indeterminate",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(claimTime).toISOString(),
  };
  const resolutionTimes: number[] = [];
  const store = {
    async claimNext(input: {
      workerId: string;
      leaseToken: string;
      now: number;
      leaseMs: number;
    }): Promise<ExternalReconciliationClaim> {
      assert.equal(input.now, claimTime);
      return {
        reconciliation: {
          reconciliationId: "reconciliation-freshness",
          executionKey: "external:freshness",
          actionId: "action-freshness",
          requestId: "request-freshness",
          projectId: "project-freshness",
          tool: "quotes",
          operation: "send",
          idempotencyKey: "idempotency-freshness",
          actionFingerprint: "jarvis-action-fingerprint:v1:freshness",
          effectFingerprint: "jarvis-effect-fingerprint:v1:freshness",
          provider: "demo-provider",
          providerRequestId: "provider-request-freshness",
          providerCorrelationId: "provider-correlation-freshness",
          receiptKey: "external:freshness",
          receiptId: "receipt-freshness",
          state: "claimed",
          attemptCount: 1,
          nextAttemptAt: claimTime,
          leaseOwner: input.workerId,
          leaseToken: input.leaseToken,
          leaseExpiresAt: claimTime + input.leaseMs,
          createdAt: 0,
          updatedAt: claimTime,
        },
        receipt,
      };
    },
    async resolveClaim(input: { now: number }): Promise<ToolExecutionReceipt> {
      resolutionTimes.push(input.now);
      if (input.now >= claimTime + leaseMs) throw new Error("lease expired before resolution");
      return { ...receipt, status: "succeeded", errorCode: undefined };
    },
  } as unknown as ExternalReconciliationStore;
  const timestamps = [claimTime, completionTime];
  const worker = new ReconciliationWorker({
    store,
    adapters: [
      {
        provider: "demo-provider",
        async reconcile() {
          return { status: "succeeded" as const };
        },
      },
    ],
    now: () => timestamps.shift() ?? completionTime,
    leaseToken: () => "lease-freshness",
  });

  await assert.rejects(
    worker.runOnce({
      workerId: "worker-freshness",
      leaseMs,
      signal: new AbortController().signal,
    }),
    /lease expired before resolution/,
  );
  assert.deepEqual(resolutionTimes, [completionTime]);
});
