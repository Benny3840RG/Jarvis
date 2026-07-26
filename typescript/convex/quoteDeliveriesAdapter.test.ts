import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { ConvexQuoteDeliveryRepository } from "../src/persistence/convexQuoteDeliveries.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";

const SERVICE_TOKEN = "quote-delivery-adapter-test-token-0000000000";

type Harness = ReturnType<typeof convexTest>;

function clientFor(t: Harness): ConvexClientLike {
  return {
    query: (reference: unknown, args?: Record<string, unknown>) =>
      (t as { query: (r: unknown, a?: unknown) => Promise<unknown> }).query(reference, args),
    mutation: (reference: unknown, args?: Record<string, unknown>) =>
      (t as { mutation: (r: unknown, a?: unknown) => Promise<unknown> }).mutation(reference, args),
  } as unknown as ConvexClientLike;
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

  it("round-trips a full delivery lifecycle through a fresh repository instance (restart persistence)", async () => {
    const t = convexTest(schema, modules);
    const repository = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    const scope = {
      quoteId: "quote-1",
      revision: 1,
      recipient: "client@example.com",
      channel: "email" as const,
    };

    const created = await repository.createPending({
      ...scope,
      revisionId: "revision-1",
      revisionFingerprint: "quote-revision:v1:sha256:aaaa",
      sendFingerprint: "quote-send-fingerprint:v1:sha256:bbbb",
      idempotencyKey: "execute-send-1",
      approvalId: "execute-send-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:cccc",
      provider: "test-email-provider",
    });
    expect(created.status).toBe("pending");

    await repository.markExecuting({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "pending",
    });

    const reattached = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    const bound = await reattached.bindProviderReference({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "executing",
      providerRequestId: "provider-request-1",
      providerCorrelationId: "provider-correlation-1",
      reconciliationId: "reconciliation-abc",
    });
    expect(bound.providerRequestId).toBe("provider-request-1");
    expect(bound.reconciliationId).toBe("reconciliation-abc");

    const completed = await reattached.complete({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "executing",
      outcome: "succeeded",
    });
    expect(completed.status).toBe("succeeded");

    const fetched = await reattached.getBySendScope(scope);
    expect(fetched?.deliveryAttemptId).toBe(created.deliveryAttemptId);
    expect(fetched?.status).toBe("succeeded");

    const listed = await reattached.listForQuote({ quoteId: "quote-1" });
    expect(listed).toHaveLength(1);
    expect(listed[0].deliveryAttemptId).toBe(created.deliveryAttemptId);
  });

  it("takes an indeterminate delivery through reconciliation", async () => {
    const t = convexTest(schema, modules);
    const repository = new ConvexQuoteDeliveryRepository(clientFor(t), SERVICE_TOKEN);
    const created = await repository.createPending({
      quoteId: "quote-2",
      revision: 1,
      recipient: "client@example.com",
      channel: "email",
      revisionId: "revision-2",
      revisionFingerprint: "quote-revision:v1:sha256:dddd",
      sendFingerprint: "quote-send-fingerprint:v1:sha256:eeee",
      idempotencyKey: "execute-send-2",
      approvalId: "execute-send-2",
      actionFingerprint: "jarvis-action-fingerprint:v1:ffff",
      provider: "test-email-provider",
    });
    await repository.markExecuting({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "pending",
    });

    const indeterminate = await repository.markIndeterminate({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "executing",
      reconciliationId: "reconciliation-timeout",
    });
    expect(indeterminate.status).toBe("indeterminate");

    const reconciled = await repository.reconcile({
      deliveryAttemptId: created.deliveryAttemptId,
      expectedStatus: "indeterminate",
      reconciliationId: "reconciliation-timeout",
      outcome: "failed",
      providerErrorCode: "provider-timeout",
    });
    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.reconciledOutcome).toBe("failed");
    expect(reconciled.providerErrorCode).toBe("provider-timeout");
  });
});
