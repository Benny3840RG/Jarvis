import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "quote-delivery-test-service-token-000000000";

function harness() {
  return convexTest(schema, modules);
}

function createInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    serviceToken: SERVICE_TOKEN,
    quoteId: "quote-1",
    revision: 1,
    recipient: "client@example.com",
    channel: "email" as const,
    revisionId: "revision-1",
    revisionFingerprint: "quote-revision:v1:sha256:aaaa",
    sendFingerprint: "quote-send-fingerprint:v1:sha256:bbbb",
    idempotencyKey: "execute-send-1",
    approvalId: "execute-send-1",
    actionFingerprint: "jarvis-action-fingerprint:v1:cccc",
    provider: "test-email-provider",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("quote delivery ledger", () => {
  it("creates a pending attempt and replays the same row for a matching send-scope + fingerprint", async () => {
    const t = harness();
    const created = await t.mutation(api.quoteDeliveries.createPending, createInput());
    expect(created.status).toBe("pending");
    expect(created.deliveryAttemptId).toBeTruthy();

    const replay = await t.mutation(api.quoteDeliveries.createPending, createInput());
    expect(replay.deliveryAttemptId).toBe(created.deliveryAttemptId);

    const rowCount = await t.run(
      async (ctx) => (await ctx.db.query("quoteDeliveryAttempts").collect()).length,
    );
    expect(rowCount).toBe(1);
  });

  it("rejects a second attempt at the same send-scope with a different send fingerprint", async () => {
    const t = harness();
    await t.mutation(api.quoteDeliveries.createPending, createInput());

    await expect(
      t.mutation(
        api.quoteDeliveries.createPending,
        createInput({ sendFingerprint: "quote-send-fingerprint:v1:sha256:different" }),
      ),
    ).rejects.toThrow(/different send fingerprint/);
  });

  it("walks pending -> executing -> succeeded and enforces expected-status CAS", async () => {
    const t = harness();
    const created = await t.mutation(api.quoteDeliveries.createPending, createInput());

    const executing = await t.mutation(api.quoteDeliveries.markExecuting, {
      serviceToken: SERVICE_TOKEN,
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "pending",
    });
    expect(executing.status).toBe("executing");
    expect(executing.executionStartedAt).toBeGreaterThan(0);

    await expect(
      t.mutation(api.quoteDeliveries.markExecuting, {
        serviceToken: SERVICE_TOKEN,
        deliveryAttemptId: created.deliveryAttemptId,
        expectedStatus: "pending",
      }),
    ).rejects.toThrow(/is executing, expected pending/);

    const bound = await t.mutation(api.quoteDeliveries.bindProviderReference, {
      serviceToken: SERVICE_TOKEN,
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "executing",
      providerRequestId: "provider-request-1",
      providerCorrelationId: "provider-correlation-1",
    });
    expect(bound.providerRequestId).toBe("provider-request-1");
    expect(bound.status).toBe("executing");

    const completed = await t.mutation(api.quoteDeliveries.complete, {
      serviceToken: SERVICE_TOKEN,
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "executing",
      outcome: "succeeded",
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.completedAt).toBeGreaterThan(0);
  });

  it("walks executing -> indeterminate -> reconciled and rejects reconciling against the wrong record", async () => {
    const t = harness();
    const created = await t.mutation(api.quoteDeliveries.createPending, createInput());
    await t.mutation(api.quoteDeliveries.markExecuting, {
      serviceToken: SERVICE_TOKEN,
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "pending",
    });

    const indeterminate = await t.mutation(api.quoteDeliveries.markIndeterminate, {
      serviceToken: SERVICE_TOKEN,
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "executing",
      reconciliationId: "reconciliation-abc",
    });
    expect(indeterminate.status).toBe("indeterminate");
    expect(indeterminate.reconciliationId).toBe("reconciliation-abc");

    await expect(
      t.mutation(api.quoteDeliveries.reconcile, {
        serviceToken: SERVICE_TOKEN,
        deliveryAttemptId: created.deliveryAttemptId,
        expectedStatus: "indeterminate",
        reconciliationId: "reconciliation-wrong",
        outcome: "succeeded",
      }),
    ).rejects.toThrow(/different reconciliation record/);

    const reconciled = await t.mutation(api.quoteDeliveries.reconcile, {
      serviceToken: SERVICE_TOKEN,
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "indeterminate",
      reconciliationId: "reconciliation-abc",
      outcome: "succeeded",
    });
    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.reconciledOutcome).toBe("succeeded");
    expect(reconciled.reconciledAt).toBeGreaterThan(0);
  });

  it("lists delivery attempts for a quote, optionally scoped to one revision, newest first", async () => {
    const t = harness();
    await t.mutation(
      api.quoteDeliveries.createPending,
      createInput({ recipient: "a@example.com" }),
    );
    await t.mutation(
      api.quoteDeliveries.createPending,
      createInput({
        recipient: "b@example.com",
        sendFingerprint: "quote-send-fingerprint:v1:sha256:b",
      }),
    );
    await t.mutation(
      api.quoteDeliveries.createPending,
      createInput({
        revision: 2,
        recipient: "a@example.com",
        revisionId: "revision-2",
        sendFingerprint: "quote-send-fingerprint:v1:sha256:r2",
      }),
    );

    const all = await t.query(api.quoteDeliveries.listForQuote, {
      serviceToken: SERVICE_TOKEN,
      quoteId: "quote-1",
    });
    expect(all).toHaveLength(3);

    const revisionOne = await t.query(api.quoteDeliveries.listForQuote, {
      serviceToken: SERVICE_TOKEN,
      quoteId: "quote-1",
      revision: 1,
    });
    expect(revisionOne).toHaveLength(2);
    expect(revisionOne.every((attempt) => attempt.revision === 1)).toBe(true);
  });

  it("returns identical external behavior for absent and cross-owner delivery attempts", async () => {
    const t = harness();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("quoteDeliveryAttempts", {
        ownerId: "other-owner",
        deliveryAttemptId: "other-delivery",
        quoteId: "quote-1",
        revision: 1,
        revisionId: "revision-1",
        revisionFingerprint: "quote-revision:v1:sha256:aaaa",
        recipient: "client@example.com",
        channel: "email",
        sendFingerprint: "quote-send-fingerprint:v1:sha256:bbbb",
        idempotencyKey: "other-idempotency",
        approvalId: "other-approval",
        actionFingerprint: "jarvis-action-fingerprint:v1:other",
        status: "pending",
        provider: "test-email-provider",
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(api.quoteDeliveries.markExecuting, {
        serviceToken: SERVICE_TOKEN,
        deliveryAttemptId: "other-delivery",
        expectedStatus: "pending",
      }),
    ).rejects.toThrow("Quote delivery attempt not found.");
    await expect(
      t.mutation(api.quoteDeliveries.markExecuting, {
        serviceToken: SERVICE_TOKEN,
        deliveryAttemptId: "missing-delivery",
        expectedStatus: "pending",
      }),
    ).rejects.toThrow("Quote delivery attempt not found.");

    const scoped = await t.query(api.quoteDeliveries.getBySendScope, {
      serviceToken: SERVICE_TOKEN,
      quoteId: "quote-1",
      revision: 1,
      recipient: "client@example.com",
      channel: "email",
    });
    expect(scoped).toBeNull();
  });
});
