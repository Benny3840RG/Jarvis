import assert from "node:assert/strict";
import { it } from "node:test";

import type { ToolExecutionReceipt } from "../src/actions/toolExecution.js";
import type {
  ExternalReconciliationClaim,
  ExternalReconciliationStore,
} from "../src/reconciliation/externalReconciliation.js";
import { ReconciliationWorker } from "../src/reconciliation/reconciliationWorker.js";

it("propagates a server-side lease rejection instead of reporting a stale success", async () => {
  // Lease/authority timing is enforced entirely server-side against the server's own
  // clock (see convex/externalReconciliations.ts); the worker no longer supplies `now`
  // and must not assume a resolution is safe just because it thinks the lease is fresh.
  // This simulates the authoritative store rejecting a resolution whose lease has
  // genuinely expired by the time the provider call completed, and proves the worker
  // propagates that rejection rather than reporting a stale success.
  const claimTime = 1_000;
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
  let resolveCalls = 0;
  const store = {
    async claimNext(input: {
      workerId: string;
      leaseToken: string;
      leaseMs: number;
    }): Promise<ExternalReconciliationClaim> {
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
    async resolveClaim(): Promise<ToolExecutionReceipt> {
      resolveCalls += 1;
      throw new Error("Reconciliation claim lease is stale or belongs to another worker.");
    },
  } as unknown as ExternalReconciliationStore;
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
    leaseToken: () => "lease-freshness",
  });

  await assert.rejects(
    worker.runOnce({
      workerId: "worker-freshness",
      leaseMs,
      signal: new AbortController().signal,
    }),
    /lease is stale or belongs to another worker/,
  );
  assert.equal(resolveCalls, 1);
});
