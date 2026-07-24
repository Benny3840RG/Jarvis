import { randomUUID } from "node:crypto";

import type { ToolExecutionReceipt } from "../actions/toolExecution.js";
import type { ExternalReconciliationStore } from "../reconciliation/externalReconciliation.js";
import { ReconciliationWorker } from "../reconciliation/reconciliationWorker.js";
import type { SmokeWriter } from "./convexSmoke.js";

export type ExternalReconciliationSmokeResult = {
  attemptRegistered: boolean;
  indeterminatePersisted: boolean;
  restartClaimed: boolean;
  providerResolved: boolean;
  authoritativeReceiptVerified: boolean;
  cleaned: boolean;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function runExternalReconciliationSmoke(
  makeStore: () => ExternalReconciliationStore,
  deployment: string | undefined,
  write: SmokeWriter = (message) => console.log(message),
): Promise<ExternalReconciliationSmokeResult> {
  if (!deployment?.trim().startsWith("dev:")) {
    throw new Error(
      "External reconciliation smoke refused: CONVEX_DEPLOYMENT must identify a development deployment (dev:...).",
    );
  }

  const marker = `jarvis-external-reconciliation-smoke-${randomUUID()}`;
  const reconciliationId = `${marker}-reconciliation`;
  const projectId = `${marker}-project`;
  const actionId = `${marker}-action`;
  const requestId = `${marker}-request`;
  const idempotencyKey = `${marker}-idempotency`;
  const executionKey = `${projectId}:${actionId}:${idempotencyKey}`;
  const receiptKey = executionKey;
  const actionFingerprint = `jarvis-action-fingerprint:v1:${"a".repeat(64)}`;
  const effectFingerprint = `jarvis-effect-fingerprint:v1:${"b".repeat(64)}`;
  const provider = "jarvis-commissioning-provider";
  const providerRequestId = `${marker}-provider-request`;
  const providerCorrelationId = `${marker}-provider-correlation`;
  const scope = {
    projectId,
    tool: "commissioning",
    operation: "reconcile",
    idempotencyKey,
    effectFingerprint,
  };

  let recordCreated = false;
  let cleaned = false;
  let primaryError: Error | undefined;
  let result: ExternalReconciliationSmokeResult | undefined;

  try {
    const registered = await makeStore().registerAttempt({
      ...scope,
      reconciliationId,
      executionKey,
      actionId,
      requestId,
      actionFingerprint,
      reference: {
        provider,
        providerRequestId,
        providerCorrelationId,
      },
    });
    recordCreated = true;
    requireCondition(
      registered.reconciliationId === reconciliationId && registered.state === "observing",
      "reconciliation: provider attempt registration did not persist the observing record.",
    );

    const now = Date.now();
    const indeterminateReceipt: ToolExecutionReceipt = {
      receiptId: `${marker}-receipt`,
      actionId,
      requestId,
      projectId,
      idempotencyKey,
      actionFingerprint,
      effectFingerprint,
      tool: scope.tool,
      operation: scope.operation,
      actor: "tool",
      policyVersion: "totality-policy:v1",
      correlationId: requestId,
      source: "development-commissioning",
      provider,
      providerRequestId,
      providerCorrelationId,
      reconciliationId,
      status: "indeterminate",
      errorCode: "indeterminate",
      startedAt: new Date(now - 1_000).toISOString(),
      completedAt: new Date(now).toISOString(),
    };
    const pending = await makeStore().markIndeterminate({
      ...scope,
      reconciliationId,
      executionKey,
      actionId,
      requestId,
      actionFingerprint,
      expectedProvider: provider,
      receiptKey,
      receipt: indeterminateReceipt,
    });
    requireCondition(
      pending.reconciliation.state === "pending" && pending.receipt?.status === "indeterminate",
      "reconciliation: indeterminate receipt and pending queue record were not bound atomically.",
    );

    const worker = new ReconciliationWorker({
      store: makeStore(),
      adapters: [
        {
          provider,
          async reconcile(reference) {
            requireCondition(
              reference.providerRequestId === providerRequestId &&
                reference.providerCorrelationId === providerCorrelationId,
              "reconciliation: worker did not receive the durable provider reference.",
            );
            return {
              status: "succeeded" as const,
              outputDigest: `${marker}-resolved-digest`,
            };
          },
        },
      ],
      leaseToken: () => `${marker}-lease`,
    });
    const workerResult = await worker.runOnce({
      workerId: `${marker}-worker`,
      leaseMs: 30_000,
      signal: new AbortController().signal,
    });
    requireCondition(
      workerResult.status === "resolved" && workerResult.terminalStatus === "succeeded",
      "reconciliation: fresh worker instance did not resolve the pending provider attempt.",
    );

    const authoritative = await makeStore().getByScope(scope);
    requireCondition(
      authoritative?.reconciliation.state === "resolved" &&
        authoritative.reconciliation.terminalStatus === "succeeded" &&
        authoritative.receipt?.status === "succeeded" &&
        authoritative.receipt.outputDigest === `${marker}-resolved-digest`,
      "reconciliation: authoritative receipt did not become the proven terminal result.",
    );

    requireCondition(
      await makeStore().cleanup(reconciliationId),
      "reconciliation: cleanup did not remove the synthetic record and receipt.",
    );
    cleaned = true;
    requireCondition(
      (await makeStore().getByScope(scope)) === null,
      "reconciliation: synthetic state remained visible after cleanup.",
    );

    result = {
      attemptRegistered: true,
      indeterminatePersisted: true,
      restartClaimed: true,
      providerResolved: true,
      authoritativeReceiptVerified: true,
      cleaned: true,
    };
  } catch (error: unknown) {
    primaryError = normalizeError(error);
  }

  const cleanupErrors: unknown[] = [];
  if (recordCreated && !cleaned) {
    try {
      requireCondition(
        await makeStore().cleanup(reconciliationId),
        "reconciliation: fallback cleanup did not remove the synthetic record and receipt.",
      );
      requireCondition(
        (await makeStore().getByScope(scope)) === null,
        "reconciliation: synthetic state remained after fallback cleanup.",
      );
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      "external reconciliation smoke cleanup failed.",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  requireCondition(
    result !== undefined,
    "external reconciliation smoke finished without a result.",
  );

  write(
    "Convex smoke passed for external reconciliation: provider reference, indeterminate persistence, restart recovery, terminal resolution and cleanup.",
  );
  return result;
}
