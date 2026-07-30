import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolExecutionReceipt } from "../src/actions/toolExecution.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexExternalReconciliationStore } from "../src/persistence/convexExternalReconciliations.js";

const NOW = 1_785_000_000_000;

function reconciliationRow(overrides: Record<string, unknown> = {}) {
  return {
    reconciliationId: "reconciliation-1",
    executionKey: "external:scope-1",
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    idempotencyKey: "idempotency-1",
    actionFingerprint: "jarvis-action-fingerprint:v1:action",
    effectFingerprint: "jarvis-effect-fingerprint:v1:effect",
    tool: "quotes",
    operation: "send",
    provider: "demo-provider",
    providerRequestId: "provider-request-1",
    providerCorrelationId: "provider-correlation-1",
    receiptKey: "external:scope-1",
    receiptId: "receipt-1",
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: NOW,
    createdAt: NOW - 1_000,
    updatedAt: NOW,
    ...overrides,
  };
}

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: "receipt-1",
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    idempotencyKey: "idempotency-1",
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
    status: "indeterminate",
    errorCode: "indeterminate",
    startedAt: NOW - 1_000,
    completedAt: NOW,
    ...overrides,
  };
}

function receipt(): ToolExecutionReceipt {
  return {
    receiptId: "receipt-1",
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    idempotencyKey: "idempotency-1",
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
    status: "indeterminate",
    errorCode: "indeterminate",
    startedAt: new Date(NOW - 1_000).toISOString(),
    completedAt: new Date(NOW).toISOString(),
  };
}

function clientWithReturns(
  returns: unknown[],
  calls: unknown[],
): ConvexClientLike {
  return {
    async query(_functionRef: unknown, args: unknown) {
      calls.push({ kind: "query", args });
      return returns.shift();
    },
    async mutation(_functionRef: unknown, args: unknown) {
      calls.push({ kind: "mutation", args });
      return returns.shift();
    },
  } as unknown as ConvexClientLike;
}

describe("ConvexExternalReconciliationStore", () => {
  it("requires an authenticated service token", () => {
    const client = clientWithReturns([], []);
    assert.throws(
      () =>
        new ConvexExternalReconciliationStore(
          client,
          "",
          "dev:outgoing-ram-798",
        ),
      /requires JARVIS_SERVICE_TOKEN/,
    );
  });

  it("passes exact scope, provider references, receipt metadata and timestamps", async () => {
    const calls: unknown[] = [];
    const client = clientWithReturns(
      [
        reconciliationRow({
          state: "observing",
          receiptKey: undefined,
          receiptId: undefined,
        }),
        {
          reconciliation: reconciliationRow(),
          receipt: receiptRow(),
        },
      ],
      calls,
    );
    const store = new ConvexExternalReconciliationStore(
      client,
      "owner-service-token",
      "dev:outgoing-ram-798",
    );
    const scope = {
      projectId: "project-1",
      tool: "quotes",
      operation: "send",
      idempotencyKey: "idempotency-1",
      effectFingerprint: "jarvis-effect-fingerprint:v1:effect",
    };

    const registered = await store.registerAttempt({
      ...scope,
      reconciliationId: "reconciliation-1",
      executionKey: "external:scope-1",
      actionId: "action-1",
      requestId: "request-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:action",
      reference: {
        provider: "demo-provider",
        providerRequestId: "provider-request-1",
        providerCorrelationId: "provider-correlation-1",
      },
    });
    const pending = await store.markIndeterminate({
      ...scope,
      reconciliationId: "reconciliation-1",
      executionKey: "external:scope-1",
      actionId: "action-1",
      requestId: "request-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:action",
      expectedProvider: "demo-provider",
      receiptKey: "external:scope-1",
      receipt: receipt(),
    });

    assert.equal(registered.state, "observing");
    assert.equal(
      pending.receipt?.startedAt,
      new Date(NOW - 1_000).toISOString(),
    );
    assert.deepEqual(calls, [
      {
        kind: "mutation",
        args: {
          serviceToken: "owner-service-token",
          ...scope,
          reconciliationId: "reconciliation-1",
          executionKey: "external:scope-1",
          actionId: "action-1",
          requestId: "request-1",
          actionFingerprint: "jarvis-action-fingerprint:v1:action",
          provider: "demo-provider",
          providerRequestId: "provider-request-1",
          providerCorrelationId: "provider-correlation-1",
        },
      },
      {
        kind: "mutation",
        args: {
          serviceToken: "owner-service-token",
          ...scope,
          reconciliationId: "reconciliation-1",
          executionKey: "external:scope-1",
          actionId: "action-1",
          requestId: "request-1",
          actionFingerprint: "jarvis-action-fingerprint:v1:action",
          expectedProvider: "demo-provider",
          receiptKey: "external:scope-1",
          receipt: {
            receiptId: "receipt-1",
            actionId: "action-1",
            requestId: "request-1",
            projectId: "project-1",
            idempotencyKey: "idempotency-1",
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
            status: "indeterminate",
            errorCode: "indeterminate",
            startedAt: NOW - 1_000,
            completedAt: NOW,
          },
        },
      },
    ]);
  });

  it("maps claims and passes exact lease, resolution, release and cleanup arguments", async () => {
    const calls: unknown[] = [];
    const client = clientWithReturns(
      [
        {
          reconciliation: reconciliationRow({
            state: "claimed",
            attemptCount: 1,
            leaseOwner: "worker-1",
            leaseToken: "lease-1",
            leaseExpiresAt: NOW + 30_000,
          }),
          receipt: receiptRow(),
        },
        receiptRow({
          status: "succeeded",
          errorCode: undefined,
          outputDigest: "digest-1",
        }),
        reconciliationRow({
          state: "pending",
          attemptCount: 1,
          nextAttemptAt: NOW + 5_000,
          lastErrorCode: "still-processing",
        }),
        true,
      ],
      calls,
    );
    const store = new ConvexExternalReconciliationStore(
      client,
      "owner-service-token",
      "dev:outgoing-ram-798",
    );

    const claim = await store.claimNext({
      workerId: "worker-1",
      leaseToken: "lease-1",
      now: NOW,
      leaseMs: 30_000,
    });
    const resolved = await store.resolveClaim({
      reconciliationId: "reconciliation-1",
      workerId: "worker-1",
      leaseToken: "lease-1",
      now: NOW + 1_000,
      result: { status: "succeeded", outputDigest: "digest-1" },
    });
    const released = await store.releaseClaim({
      reconciliationId: "reconciliation-1",
      workerId: "worker-1",
      leaseToken: "lease-1",
      now: NOW + 2_000,
      errorCode: "still-processing",
      nextAttemptAt: NOW + 5_000,
      maxAttempts: 5,
    });
    const cleaned = await store.cleanup("reconciliation-1");

    assert.equal(claim?.reconciliation.leaseOwner, "worker-1");
    assert.equal(claim?.receipt.startedAt, new Date(NOW - 1_000).toISOString());
    assert.equal(resolved.status, "succeeded");
    assert.equal(released.state, "pending");
    assert.equal(cleaned, true);
    assert.deepEqual(
      calls.map((call) => (call as { args: unknown }).args),
      [
        {
          serviceToken: "owner-service-token",
          workerId: "worker-1",
          leaseToken: "lease-1",
          now: NOW,
          leaseMs: 30_000,
        },
        {
          serviceToken: "owner-service-token",
          reconciliationId: "reconciliation-1",
          workerId: "worker-1",
          leaseToken: "lease-1",
          now: NOW + 1_000,
          result: { status: "succeeded", outputDigest: "digest-1" },
        },
        {
          serviceToken: "owner-service-token",
          reconciliationId: "reconciliation-1",
          workerId: "worker-1",
          leaseToken: "lease-1",
          now: NOW + 2_000,
          errorCode: "still-processing",
          nextAttemptAt: NOW + 5_000,
          maxAttempts: 5,
        },
        {
          serviceToken: "owner-service-token",
          reconciliationId: "reconciliation-1",
          deployment: "dev:outgoing-ram-798",
        },
      ],
    );
  });
});

describe("ConvexExternalReconciliationStore operator reads", () => {
  it("maps bounded list and detail reads without invoking mutations", async () => {
    const calls: unknown[] = [];
    const client = clientWithReturns(
      [
        [
          reconciliationRow({
            state: "escalated",
            escalationReason: "operator-review",
          }),
        ],
        {
          reconciliation: reconciliationRow({
            state: "resolved",
            terminalStatus: "succeeded",
            resolvedAt: NOW,
          }),
          receipt: receiptRow({ status: "succeeded", errorCode: undefined }),
        },
      ],
      calls,
    );
    const store = new ConvexExternalReconciliationStore(
      client,
      "owner-service-token",
      "dev:outgoing-ram-798",
    );

    const listed = await store.listForOperator({
      state: "escalated",
      limit: 25,
    });
    const detail = await store.getForOperator("reconciliation-1");

    assert.equal(listed[0]?.state, "escalated");
    assert.equal(detail?.reconciliation.terminalStatus, "succeeded");
    assert.equal(detail?.receipt?.completedAt, new Date(NOW).toISOString());
    assert.deepEqual(calls, [
      {
        kind: "query",
        args: {
          serviceToken: "owner-service-token",
          state: "escalated",
          limit: 25,
        },
      },
      {
        kind: "query",
        args: {
          serviceToken: "owner-service-token",
          reconciliationId: "reconciliation-1",
        },
      },
    ]);
  });
});
