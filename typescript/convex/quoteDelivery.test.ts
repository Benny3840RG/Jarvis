import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { ConvexQuoteDeliveryRepository } from "../src/quotes/convexQuoteDeliveryRepository.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";

const SERVICE_TOKEN = "quote-delivery-test-service-token-000000000";

type Harness = ReturnType<typeof convexTest>;

function clientFor(t: Harness): ConvexClientLike {
  return {
    query: (reference: unknown, args?: Record<string, unknown>) =>
      (t as { query: (r: unknown, a?: unknown) => Promise<unknown> }).query(reference, args),
    mutation: (reference: unknown, args?: Record<string, unknown>) =>
      (t as { mutation: (r: unknown, a?: unknown) => Promise<unknown> }).mutation(reference, args),
  } as unknown as ConvexClientLike;
}

function sendInput(
  overrides: Partial<Parameters<ConvexQuoteDeliveryRepository["createPending"]>[0]> = {},
) {
  return {
    quoteId: "quote-1",
    revision: 1,
    recipient: "client@example.com",
    channel: "email" as const,
    revisionId: "revision-1",
    revisionFingerprint: "quote-revision:v1:sha256:aaaa",
    sendFingerprint: "quote-send:v1:sha256:bbbb",
    idempotencyKey: "send-quote-1-r1-client",
    approvalId: "approval-1",
    actionFingerprint: "jarvis-action-fingerprint:v1:sha256:cccc",
    provider: "postmark",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ConvexQuoteDeliveryRepository against persisted Convex functions", () => {
  it("requires a service token", () => {
    const t = convexTest(schema, modules);
    expect(() => new ConvexQuoteDeliveryRepository(clientFor(t), "")).toThrow(
      /requires JARVIS_SERVICE_TOKEN/,
    );
  });

  it("creates a pending delivery attempt and reads it back through a fresh repository instance", async () => {
    const t = convexTest(schema, modules);
    const created = await new ConvexQuoteDeliveryRepository(
      clientFor(t),
      SERVICE_TOKEN,
    ).createPending(sendInput());

    expect(created).toMatchObject({
      ownerId: "jarvis-cli",
      quoteId: "quote-1",
      revision: 1,
      recipient: "client@example.com",
      channel: "email",
      status: "pending",
      provider: "postmark",
    });
    expect(created).not.toHaveProperty("_id");
    expect(created).not.toHaveProperty("_creationTime");

    const reopened = await new ConvexQuoteDeliveryRepository(
      clientFor(t),
      SERVICE_TOKEN,
    ).getBySendScope({
      quoteId: "quote-1",
      revision: 1,
      recipient: "client@example.com",
      channel: "email",
    });
    expect(reopened?.deliveryAttemptId).toBe(created.deliveryAttemptId);

    expect(
      await new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN).getBySendScope({
        quoteId: "quote-1",
        revision: 1,
        recipient: "someone-else@example.com",
        channel: "email",
      }),
    ).toBe(null);
  });

  it("treats a repeat create with the same send fingerprint as an idempotent duplicate", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    const first = await repo.createPending(sendInput());
    const second = await repo.createPending(sendInput());
    expect(second.deliveryAttemptId).toBe(first.deliveryAttemptId);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("rejects a repeat create for the same scope with a different send fingerprint", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    await repo.createPending(sendInput());
    await expect(
      repo.createPending(sendInput({ sendFingerprint: "quote-send:v1:sha256:different" })),
    ).rejects.toThrow(/already exists/);
  });

  it("treats a changed recipient as a distinct delivery attempt, not a duplicate", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    const original = await repo.createPending(sendInput());
    const rerouted = await repo.createPending(
      sendInput({ recipient: "other@example.com", sendFingerprint: "quote-send:v1:sha256:dddd" }),
    );
    expect(rerouted.deliveryAttemptId).not.toBe(original.deliveryAttemptId);
  });

  it("drives the full pending → executing → succeeded lifecycle", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    const created = await repo.createPending(sendInput());

    const executing = await repo.markExecuting({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "pending",
    });
    expect(executing.status).toBe("executing");
    expect(executing.executionStartedAt).toBeDefined();

    const bound = await repo.bindProviderReference({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "executing",
      providerRequestId: "provider-req-1",
      providerCorrelationId: "provider-corr-1",
    });
    expect(bound.providerRequestId).toBe("provider-req-1");
    expect(bound.status).toBe("executing");

    const completed = await repo.complete({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "executing",
      outcome: "succeeded",
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.completedAt).toBeDefined();
  });

  it("drives the executing → indeterminate → reconciled lifecycle", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    const created = await repo.createPending(sendInput());
    await repo.markExecuting({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "pending",
    });

    const indeterminate = await repo.markIndeterminate({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "executing",
      reconciliationId: "reconciliation-1",
    });
    expect(indeterminate.status).toBe("indeterminate");
    expect(indeterminate.reconciliationId).toBe("reconciliation-1");

    const reconciled = await repo.reconcile({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "indeterminate",
      reconciliationId: "reconciliation-1",
      outcome: "succeeded",
    });
    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.reconciledOutcome).toBe("succeeded");
    expect(reconciled.reconciledAt).toBeDefined();
  });

  it("rejects reconciliation with a reconciliation ID that does not match the pending indeterminate attempt", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    const created = await repo.createPending(sendInput());
    await repo.markExecuting({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "pending",
    });
    await repo.markIndeterminate({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "executing",
      reconciliationId: "reconciliation-1",
    });

    await expect(
      repo.reconcile({
        deliveryAttemptId: created.deliveryAttemptId,
        expectedStatus: "indeterminate",
        reconciliationId: "reconciliation-wrong",
        outcome: "succeeded",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("blocks a blind retry: completing an attempt that never entered the executing state", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    const created = await repo.createPending(sendInput());

    await expect(
      repo.complete({
        deliveryAttemptId: created.deliveryAttemptId,
        expectedStatus: "executing",
        outcome: "succeeded",
      }),
    ).rejects.toThrow(/expected executing/);
  });

  it("blocks re-executing an attempt that already left the pending state", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    const created = await repo.createPending(sendInput());
    await repo.markExecuting({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "pending",
    });

    await expect(
      repo.markExecuting({
        deliveryAttemptId: created.deliveryAttemptId,
        expectedStatus: "pending",
      }),
    ).rejects.toThrow(/expected pending/);
  });

  it("returns not-found for an unknown delivery attempt id", async () => {
    const t = convexTest(schema, modules);
    const repo = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    await expect(
      repo.markExecuting({ deliveryAttemptId: "missing", expectedStatus: "pending" }),
    ).rejects.toThrow(/not found/);
  });
});
