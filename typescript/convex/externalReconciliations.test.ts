import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "external-reconciliation-test-service-token-0000";
const OWNER_ID = "jarvis-cli";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedReceipt(ctx: MutationCtx, receiptKey: string) {
  await ctx.db.insert("toolExecutionReceipts", {
    ownerId: OWNER_ID,
    receiptKey,
    receiptId: `${receiptKey}-receipt`,
    actionId: `${receiptKey}-action`,
    projectId: "project-1",
    idempotencyKey: `${receiptKey}-idempotency`,
    actionFingerprint: `${receiptKey}-fingerprint`,
    tool: "quotes",
    operation: "send",
    status: "indeterminate",
    startedAt: Date.now(),
    completedAt: Date.now(),
    createdAt: Date.now(),
  });
}

async function seedClaimedReconciliation(
  ctx: MutationCtx,
  overrides: { leaseExpiresAt: number; leaseOwner: string; leaseToken: string },
) {
  const receiptKey = "receipt-key-1";
  await seedReceipt(ctx, receiptKey);
  return ctx.db.insert("externalReconciliations", {
    ownerId: OWNER_ID,
    reconciliationId: "reconciliation-1",
    executionKey: "execution-1",
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    idempotencyKey: "idempotency-1",
    actionFingerprint: "fingerprint-1",
    effectFingerprint: "effect-fingerprint-1",
    tool: "quotes",
    operation: "send",
    provider: "test-provider",
    providerRequestId: "provider-request-1",
    providerCorrelationId: "provider-correlation-1",
    receiptKey,
    state: "claimed",
    attemptCount: 1,
    nextAttemptAt: Date.now(),
    leaseOwner: overrides.leaseOwner,
    leaseToken: overrides.leaseToken,
    leaseExpiresAt: overrides.leaseExpiresAt,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

describe("claimNext lease-expiry reclaim (worker-crash recovery)", () => {
  it("reclaims a claimed record whose lease has expired for a different worker", async () => {
    const t = harness();
    const now = Date.now();
    const recordId = await t.run((ctx) =>
      seedClaimedReconciliation(ctx, {
        leaseExpiresAt: now - 1_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      }),
    );

    const claim = await t.mutation(api.externalReconciliations.claimNext, {
      serviceToken: SERVICE_TOKEN,
      workerId: "worker-B",
      leaseToken: "lease-token-B",
      now,
      leaseMs: 30_000,
    });

    expect(claim).not.toBeNull();
    expect(claim?.reconciliation._id).toBe(recordId);
    expect(claim?.reconciliation.leaseOwner).toBe("worker-B");
    expect(claim?.reconciliation.leaseToken).toBe("lease-token-B");
    expect(claim?.reconciliation.leaseExpiresAt).toBe(now + 30_000);
    expect(claim?.reconciliation.attemptCount).toBe(2);
    expect(claim?.reconciliation.state).toBe("claimed");

    const rows = await t.run((ctx) =>
      ctx.db
        .query("externalReconciliations")
        .withIndex("by_owner_and_reconciliation_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("reconciliationId", "reconciliation-1"),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  it("does not reclaim a claimed record whose lease has not expired yet", async () => {
    const t = harness();
    const now = Date.now();
    await t.run((ctx) =>
      seedClaimedReconciliation(ctx, {
        leaseExpiresAt: now + 30_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      }),
    );

    const claim = await t.mutation(api.externalReconciliations.claimNext, {
      serviceToken: SERVICE_TOKEN,
      workerId: "worker-B",
      leaseToken: "lease-token-B",
      now,
      leaseMs: 30_000,
    });

    expect(claim).toBeNull();
  });
});

async function seedQuoteDelivery(ctx: MutationCtx, reconciliationId = "reconciliation-1") {
  return ctx.db.insert("quoteDeliveryAttempts", {
    ownerId: OWNER_ID,
    deliveryAttemptId: "delivery-attempt-1",
    quoteId: "quote-1",
    revision: 1,
    revisionId: "quote-1-revision-1",
    revisionFingerprint: "quote-revision:v1:sha256:abc",
    recipient: "client@example.com",
    channel: "email",
    sendFingerprint: "quote-send-fingerprint:v1:sha256:def",
    idempotencyKey: "idempotency-1",
    approvalId: "approval-1",
    actionFingerprint: "fingerprint-1",
    status: "indeterminate",
    provider: "test-provider",
    providerRequestId: "provider-request-1",
    providerCorrelationId: "provider-correlation-1",
    reconciliationId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function seedObservingReconciliation(
  ctx: MutationCtx,
  input: {
    reconciliationId: string;
    nextAttemptAt: number;
  },
) {
  return ctx.db.insert("externalReconciliations", {
    ownerId: OWNER_ID,
    reconciliationId: input.reconciliationId,
    executionKey: `execution-${input.reconciliationId}`,
    actionId: `action-${input.reconciliationId}`,
    requestId: `request-${input.reconciliationId}`,
    projectId: "project-1",
    idempotencyKey: `idempotency-${input.reconciliationId}`,
    actionFingerprint: `fingerprint-${input.reconciliationId}`,
    effectFingerprint: `effect-${input.reconciliationId}`,
    tool: "quotes",
    operation: "send",
    provider: "test-provider",
    providerRequestId: `provider-request-${input.reconciliationId}`,
    providerCorrelationId: `provider-correlation-${input.reconciliationId}`,
    state: "observing",
    attemptCount: 0,
    nextAttemptAt: input.nextAttemptAt,
    createdAt: input.nextAttemptAt,
    updatedAt: input.nextAttemptAt,
  });
}

describe("terminal quote delivery projection", () => {
  it("atomically reconciles the quote delivery ledger when the provider succeeds", async () => {
    const t = harness();
    const now = Date.now();
    await t.run(async (ctx) => {
      await seedClaimedReconciliation(ctx, {
        leaseExpiresAt: now + 30_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      });
      await seedQuoteDelivery(ctx);
    });

    await t.mutation(api.externalReconciliations.resolveClaim, {
      serviceToken: SERVICE_TOKEN,
      reconciliationId: "reconciliation-1",
      workerId: "worker-A",
      leaseToken: "lease-token-A",
      now,
      result: { status: "succeeded", outputDigest: "provider-output-digest" },
    });

    const delivery = await t.run((ctx) =>
      ctx.db
        .query("quoteDeliveryAttempts")
        .withIndex("by_owner_and_reconciliation_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("reconciliationId", "reconciliation-1"),
        )
        .unique(),
    );
    expect(delivery?.status).toBe("reconciled");
    expect(delivery?.reconciledOutcome).toBe("succeeded");
    expect(delivery?.reconciledAt).toBe(now);
  });

  it("retains the provider error when the reconciled quote delivery failed", async () => {
    const t = harness();
    const now = Date.now();
    await t.run(async (ctx) => {
      await seedClaimedReconciliation(ctx, {
        leaseExpiresAt: now + 30_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      });
      await seedQuoteDelivery(ctx);
    });

    await t.mutation(api.externalReconciliations.resolveClaim, {
      serviceToken: SERVICE_TOKEN,
      reconciliationId: "reconciliation-1",
      workerId: "worker-A",
      leaseToken: "lease-token-A",
      now,
      result: { status: "failed", errorCode: "message-rejected" },
    });

    const delivery = await t.run((ctx) =>
      ctx.db
        .query("quoteDeliveryAttempts")
        .withIndex("by_owner_and_reconciliation_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("reconciliationId", "reconciliation-1"),
        )
        .unique(),
    );
    expect(delivery?.status).toBe("reconciled");
    expect(delivery?.reconciledOutcome).toBe("failed");
    expect(delivery?.providerErrorCode).toBe("message-rejected");
  });

  it("rejects a provider error that conflicts with an already reconciled delivery", async () => {
    const t = harness();
    const now = Date.now();
    await t.run(async (ctx) => {
      await seedClaimedReconciliation(ctx, {
        leaseExpiresAt: now + 30_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      });
      const deliveryId = await seedQuoteDelivery(ctx);
      await ctx.db.patch("quoteDeliveryAttempts", deliveryId, {
        status: "reconciled",
        reconciledOutcome: "failed",
        providerErrorCode: "message-rejected",
        reconciledAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(api.externalReconciliations.resolveClaim, {
        serviceToken: SERVICE_TOKEN,
        reconciliationId: "reconciliation-1",
        workerId: "worker-A",
        leaseToken: "lease-token-A",
        now,
        result: { status: "failed", errorCode: "mailbox-disabled" },
      }),
    ).rejects.toThrow("conflicts with the provider result");

    const state = await t.run(async (ctx) => {
      const reconciliation = await ctx.db
        .query("externalReconciliations")
        .withIndex("by_owner_and_reconciliation_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("reconciliationId", "reconciliation-1"),
        )
        .unique();
      const receipt = await ctx.db
        .query("toolExecutionReceipts")
        .withIndex("by_owner_and_receipt_key", (q) =>
          q.eq("ownerId", OWNER_ID).eq("receiptKey", "receipt-key-1"),
        )
        .unique();
      return { reconciliation, receipt };
    });
    expect(state.reconciliation?.state).toBe("claimed");
    expect(state.receipt?.status).toBe("indeterminate");
  });
});

describe("observing-process crash recovery", () => {
  it("escalates an observing record abandoned for more than sixty seconds", async () => {
    const t = harness();
    const now = Date.now();
    await t.run((ctx) =>
      seedObservingReconciliation(ctx, {
        reconciliationId: "stale-observing",
        nextAttemptAt: now - 60_001,
      }),
    );

    const claim = await t.mutation(api.externalReconciliations.claimNext, {
      serviceToken: SERVICE_TOKEN,
      workerId: "worker-B",
      leaseToken: "lease-token-B",
      now,
      leaseMs: 30_000,
    });
    expect(claim).toBeNull();

    const record = await t.run((ctx) =>
      ctx.db
        .query("externalReconciliations")
        .withIndex("by_owner_and_reconciliation_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("reconciliationId", "stale-observing"),
        )
        .unique(),
    );
    expect(record?.state).toBe("escalated");
    expect(record?.escalationReason).toBe("abandoned-observing-process-interruption");
    expect(record?.escalatedAt).toBe(now);
  });

  it("keeps an observation at the exact sixty-second boundary safe", async () => {
    const t = harness();
    const now = Date.now();
    await t.run((ctx) =>
      seedObservingReconciliation(ctx, {
        reconciliationId: "boundary-observing",
        nextAttemptAt: now - 60_000,
      }),
    );

    const claim = await t.mutation(api.externalReconciliations.claimNext, {
      serviceToken: SERVICE_TOKEN,
      workerId: "worker-B",
      leaseToken: "lease-token-B",
      now,
      leaseMs: 30_000,
    });
    expect(claim).toBeNull();

    const record = await t.run((ctx) =>
      ctx.db
        .query("externalReconciliations")
        .withIndex("by_owner_and_reconciliation_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("reconciliationId", "boundary-observing"),
        )
        .unique(),
    );
    expect(record?.state).toBe("observing");
    expect(record?.escalationReason).toBeUndefined();
  });

  it("leaves a fresh observing record alone while its sender may still be running", async () => {
    const t = harness();
    const now = Date.now();
    await t.run((ctx) =>
      seedObservingReconciliation(ctx, {
        reconciliationId: "fresh-observing",
        nextAttemptAt: now - 59_999,
      }),
    );

    const claim = await t.mutation(api.externalReconciliations.claimNext, {
      serviceToken: SERVICE_TOKEN,
      workerId: "worker-B",
      leaseToken: "lease-token-B",
      now,
      leaseMs: 30_000,
    });
    expect(claim).toBeNull();

    const record = await t.run((ctx) =>
      ctx.db
        .query("externalReconciliations")
        .withIndex("by_owner_and_reconciliation_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("reconciliationId", "fresh-observing"),
        )
        .unique(),
    );
    expect(record?.state).toBe("observing");
    expect(record?.escalationReason).toBeUndefined();
  });
});

describe("operator reconciliation reads", () => {
  it("lists only the authenticated owner's requested state with a bounded limit", async () => {
    const t = harness();
    const now = Date.now();
    await t.run(async (ctx) => {
      for (const [index, state] of (["escalated", "escalated", "resolved"] as const).entries()) {
        await ctx.db.insert("externalReconciliations", {
          ownerId: OWNER_ID,
          reconciliationId: `operator-${index}`,
          executionKey: `execution-${index}`,
          actionId: `action-${index}`,
          requestId: `request-${index}`,
          projectId: "project-1",
          idempotencyKey: `idempotency-${index}`,
          actionFingerprint: `action-fingerprint-${index}`,
          effectFingerprint: `effect-fingerprint-${index}`,
          tool: "quotes",
          operation: "send",
          provider: "test-provider",
          providerCorrelationId: `provider-correlation-${index}`,
          state,
          attemptCount: index,
          nextAttemptAt: now + index,
          createdAt: now + index,
          updatedAt: now + index,
          ...(state === "escalated"
            ? {
                escalationReason: "operator-review-required",
                escalatedAt: now + index,
              }
            : {
                terminalStatus: "succeeded" as const,
                resolutionDigest: "digest",
                resolvedAt: now + index,
              }),
        });
      }
      await ctx.db.insert("externalReconciliations", {
        ownerId: "another-owner",
        reconciliationId: "cross-owner-escalated",
        executionKey: "cross-owner-execution",
        actionId: "cross-owner-action",
        requestId: "cross-owner-request",
        projectId: "project-2",
        idempotencyKey: "cross-owner-idempotency",
        actionFingerprint: "cross-owner-action-fingerprint",
        effectFingerprint: "cross-owner-effect-fingerprint",
        tool: "quotes",
        operation: "send",
        provider: "test-provider",
        providerCorrelationId: "cross-owner-correlation",
        state: "escalated",
        attemptCount: 1,
        nextAttemptAt: now + 100,
        escalationReason: "must-not-leak",
        createdAt: now + 100,
        updatedAt: now + 100,
        escalatedAt: now + 100,
      });
    });

    const rows = await t.query(api.externalReconciliations.listForOperator, {
      serviceToken: SERVICE_TOKEN,
      state: "escalated",
      limit: 1,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].reconciliationId).toBe("operator-1");
    expect(rows[0].ownerId).toBe(OWNER_ID);
  });

  it("orders bounded operator lists by updatedAt even when retry order differs", async () => {
    const t = harness();
    const now = Date.now();
    await t.run(async (ctx) => {
      for (const record of [
        {
          reconciliationId: "recently-updated",
          nextAttemptAt: now,
          updatedAt: now + 100,
        },
        {
          reconciliationId: "later-retry-but-older-update",
          nextAttemptAt: now + 1_000,
          updatedAt: now,
        },
      ]) {
        await ctx.db.insert("externalReconciliations", {
          ownerId: OWNER_ID,
          reconciliationId: record.reconciliationId,
          executionKey: `execution-${record.reconciliationId}`,
          actionId: `action-${record.reconciliationId}`,
          requestId: `request-${record.reconciliationId}`,
          projectId: "project-1",
          idempotencyKey: `idempotency-${record.reconciliationId}`,
          actionFingerprint: `action-fingerprint-${record.reconciliationId}`,
          effectFingerprint: `effect-fingerprint-${record.reconciliationId}`,
          tool: "quotes",
          operation: "send",
          provider: "test-provider",
          providerCorrelationId: `correlation-${record.reconciliationId}`,
          state: "pending",
          attemptCount: 0,
          nextAttemptAt: record.nextAttemptAt,
          createdAt: now,
          updatedAt: record.updatedAt,
        });
      }
    });

    const [filtered, unfiltered] = await Promise.all([
      t.query(api.externalReconciliations.listForOperator, {
        serviceToken: SERVICE_TOKEN,
        state: "pending",
        limit: 1,
      }),
      t.query(api.externalReconciliations.listForOperator, {
        serviceToken: SERVICE_TOKEN,
        limit: 1,
      }),
    ]);

    expect(filtered.map((row) => row.reconciliationId)).toEqual(["recently-updated"]);
    expect(unfiltered.map((row) => row.reconciliationId)).toEqual(["recently-updated"]);
  });

  it("returns the same null detail for absent and cross-owner records", async () => {
    const t = harness();
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("externalReconciliations", {
        ownerId: "another-owner",
        reconciliationId: "cross-owner-record",
        executionKey: "cross-owner-execution",
        actionId: "cross-owner-action",
        requestId: "cross-owner-request",
        projectId: "project-2",
        idempotencyKey: "cross-owner-idempotency",
        actionFingerprint: "cross-owner-action-fingerprint",
        effectFingerprint: "cross-owner-effect-fingerprint",
        tool: "quotes",
        operation: "send",
        provider: "test-provider",
        providerCorrelationId: "cross-owner-correlation",
        state: "pending",
        attemptCount: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const [absent, crossOwner] = await Promise.all([
      t.query(api.externalReconciliations.getForOperator, {
        serviceToken: SERVICE_TOKEN,
        reconciliationId: "absent-record",
      }),
      t.query(api.externalReconciliations.getForOperator, {
        serviceToken: SERVICE_TOKEN,
        reconciliationId: "cross-owner-record",
      }),
    ]);

    expect(absent).toBeNull();
    expect(crossOwner).toBeNull();
  });

  it("rejects operator list limits outside 1 through 100", async () => {
    const t = harness();

    await expect(
      t.query(api.externalReconciliations.listForOperator, {
        serviceToken: SERVICE_TOKEN,
        limit: 101,
      }),
    ).rejects.toThrow("between 1 and 100");
  });
});
