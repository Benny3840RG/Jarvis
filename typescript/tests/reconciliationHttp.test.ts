import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import type {
  ExternalReconciliationEnvelope,
  ExternalReconciliationReadStore,
  ExternalReconciliationRecord,
} from "../src/reconciliation/externalReconciliation.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "reconciliation-http-test",
  deploymentVersion: null,
  currentToken: "current-secret",
};

const AUTH = { authorization: "Bearer current-secret" };
const openApps: NestFastifyApplication[] = [];

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("legacy persistence must not be reached");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: forbidden,
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: forbidden,
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

function record(overrides: Partial<ExternalReconciliationRecord> = {}): ExternalReconciliationRecord {
  return {
    reconciliationId: "reconciliation-1",
    executionKey: "external:secret-scope",
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    idempotencyKey: "secret-idempotency",
    actionFingerprint: "secret-action-fingerprint",
    effectFingerprint: "secret-effect-fingerprint",
    tool: "quotes",
    operation: "send",
    provider: "outlook",
    providerRequestId: "provider-request-1",
    providerCorrelationId: "provider-correlation-1",
    receiptKey: "secret-receipt-key",
    receiptId: "receipt-1",
    state: "escalated",
    attemptCount: 2,
    nextAttemptAt: 1_785_000_000_000,
    leaseOwner: "secret-worker",
    leaseToken: "secret-lease",
    leaseExpiresAt: 1_785_000_030_000,
    lastErrorCode: "still-processing",
    escalationReason: "operator-review-required",
    createdAt: 1_784_999_000_000,
    updatedAt: 1_785_000_000_000,
    escalatedAt: 1_785_000_000_000,
    ...overrides,
  };
}

function envelope(): ExternalReconciliationEnvelope {
  return {
    reconciliation: record({ state: "resolved", terminalStatus: "succeeded" }),
    receipt: {
      receiptId: "receipt-1",
      actionId: "action-1",
      requestId: "request-1",
      projectId: "project-1",
      idempotencyKey: "secret-idempotency",
      actionFingerprint: "secret-action-fingerprint",
      effectFingerprint: "secret-effect-fingerprint",
      tool: "quotes",
      operation: "send",
      actor: "agent",
      policyVersion: "totality-policy:v1",
      correlationId: "correlation-1",
      source: "test",
      provider: "outlook",
      providerRequestId: "provider-request-1",
      providerCorrelationId: "provider-correlation-1",
      reconciliationId: "reconciliation-1",
      status: "succeeded",
      outputDigest: "secret-output-digest",
      startedAt: "2026-07-30T00:00:00.000Z",
      completedAt: "2026-07-30T00:00:01.000Z",
    },
  };
}

async function makeApp(
  externalReconciliationReadStore: ExternalReconciliationReadStore | null,
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: unusedPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    totalityPipeline: null,
    memoryChangeSetService: null,
    toolActionService: null,
    toolExecutionService: null,
    quoteRepository: null,
    quoteDeliveryRepository: null,
    externalReconciliationReadStore,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("reconciliation operator HTTP reads", () => {
  it("lists sanitised records with exact state and limit inputs", async () => {
    const calls: unknown[] = [];
    const store: ExternalReconciliationReadStore = {
      async listForOperator(input) {
        calls.push(input);
        return [record()];
      },
      async getForOperator() {
        return null;
      },
    };
    const app = await makeApp(store);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reconciliations?state=escalated&limit=25",
      headers: AUTH,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [{ state: "escalated", limit: 25 }]);
    const body = response.json() as { data: Record<string, unknown>[]; count: number };
    assert.equal(body.count, 1);
    assert.equal(body.data[0]?.reconciliationId, "reconciliation-1");
    assert.equal(body.data[0]?.state, "escalated");
    for (const forbidden of [
      "executionKey",
      "idempotencyKey",
      "actionFingerprint",
      "effectFingerprint",
      "receiptKey",
      "leaseOwner",
      "leaseToken",
      "leaseExpiresAt",
    ]) {
      assert.equal(forbidden in body.data[0]!, false, `${forbidden} must not leave the server`);
    }
  });

  it("returns a sanitised receipt detail without output or replay secrets", async () => {
    const store: ExternalReconciliationReadStore = {
      async listForOperator() {
        return [];
      },
      async getForOperator() {
        return envelope();
      },
    };
    const app = await makeApp(store);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reconciliations/reconciliation-1",
      headers: AUTH,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      reconciliation: Record<string, unknown>;
      receipt: Record<string, unknown>;
    };
    assert.equal(body.reconciliation.state, "resolved");
    assert.equal(body.receipt.status, "succeeded");
    assert.equal("outputDigest" in body.receipt, false);
    assert.equal("idempotencyKey" in body.receipt, false);
    assert.equal("actionFingerprint" in body.receipt, false);
    assert.equal("effectFingerprint" in body.receipt, false);
  });

  it("distinguishes unavailable persistence from an empty register", async () => {
    const app = await makeApp(null);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reconciliations",
      headers: AUTH,
    });

    assert.equal(response.statusCode, 503);
    assert.match(JSON.stringify(response.json()), /reconciliation/i);
  });

  it("returns the same 404 contract for absent or owner-inaccessible detail", async () => {
    const store: ExternalReconciliationReadStore = {
      async listForOperator() {
        return [];
      },
      async getForOperator() {
        return null;
      },
    };
    const app = await makeApp(store);

    const responses = await Promise.all(
      ["absent", "cross-owner"].map((id) =>
        app.inject({
          method: "GET",
          url: `/api/v1/reconciliations/${id}`,
          headers: AUTH,
        }),
      ),
    );

    assert.equal(responses[0].statusCode, 404);
    assert.equal(responses[1].statusCode, 404);
    const normalise = (response: (typeof responses)[number]) => {
      const body = response.json() as {
        type: string;
        title: string;
        status: number;
        detail: string;
      };
      return {
        type: body.type,
        title: body.title,
        status: body.status,
        detail: body.detail,
      };
    };
    assert.deepEqual(normalise(responses[0]), normalise(responses[1]));
  });
});
