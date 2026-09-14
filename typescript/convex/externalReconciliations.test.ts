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

const safetyBinding = {
  version: "jarvis-safety-binding:v1" as const,
  phase: "tool-execute" as const,
  status: "pass" as const,
  categories: ["domain", "cross-domain", "memory", "reliability", "proposal", "tool-action"].map(
    (category) => ({
      category: category as
        "domain" | "cross-domain" | "memory" | "reliability" | "proposal" | "tool-action",
      status: "pass" as const,
      reasons: [],
    }),
  ),
};

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("external reconciliation safety evidence", () => {
  it("persists and reads the originating safety binding across the reconciliation boundary", async () => {
    const t = harness();
    const registered = await t.mutation(api.externalReconciliations.registerAttempt, {
      serviceToken: SERVICE_TOKEN,
      projectId: "project-1",
      tool: "quotes",
      operation: "send",
      idempotencyKey: "idempotency-1",
      effectFingerprint: "effect-fingerprint-1",
      reconciliationId: "reconciliation-1",
      executionKey: "execution-1",
      actionId: "action-1",
      requestId: "request-1",
      actionFingerprint: "action-fingerprint-1",
      provider: "test-provider",
      providerRequestId: "provider-request-1",
      providerCorrelationId: "provider-correlation-1",
      safetyBinding,
    });
    expect(registered.safetyBinding?.version).toBe("jarvis-safety-binding:v1");

    const readback = await t.query(api.externalReconciliations.getByScope, {
      serviceToken: SERVICE_TOKEN,
      projectId: "project-1",
      tool: "quotes",
      operation: "send",
      idempotencyKey: "idempotency-1",
      effectFingerprint: "effect-fingerprint-1",
    });
    expect(readback?.reconciliation.safetyBinding?.phase).toBe("tool-execute");
  });
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
    safetyBinding,
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
    safetyBinding,
  });
}

describe("claimNext lease-expiry reclaim (worker-crash recovery)", () => {
  it("reclaims a claimed record whose lease has expired for a different worker", async () => {
    const t = harness();
    const now = Date.now();
    vi.useFakeTimers({ now });
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
      leaseMs: 30_000,
    });

    expect(claim).toBeNull();
  });
});

describe("same-operation resume after proven non-effect", () => {
  it("records immutable no-effect evidence and reopens only the same execution scope", async () => {
    const t = harness();
    const now = Date.now();
    await t.run((ctx) =>
      seedClaimedReconciliation(ctx, {
        leaseExpiresAt: now + 30_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      }),
    );

    const receipt = await t.mutation(api.externalReconciliations.resolveClaim, {
      serviceToken: SERVICE_TOKEN,
      reconciliationId: "reconciliation-1",
      workerId: "worker-A",
      leaseToken: "lease-token-A",
      result: { status: "no-effect", evidenceDigest: "github-no-effect-evidence" },
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.providerErrorCode).toBe("provider-proved-no-effect");

    const resolved = await t.query(api.externalReconciliations.getByScope, {
      serviceToken: SERVICE_TOKEN,
      projectId: "project-1",
      tool: "quotes",
      operation: "send",
      idempotencyKey: "idempotency-1",
      effectFingerprint: "effect-fingerprint-1",
    });
    expect(resolved?.reconciliation.terminalStatus).toBe("no-effect");

    const reopened = await t.mutation(api.externalReconciliations.registerAttempt, {
      serviceToken: SERVICE_TOKEN,
      projectId: "project-1",
      tool: "quotes",
      operation: "send",
      idempotencyKey: "idempotency-1",
      effectFingerprint: "effect-fingerprint-1",
      reconciliationId: "reconciliation-1",
      executionKey: "execution-1",
      actionId: "action-1",
      requestId: "request-1",
      actionFingerprint: "fingerprint-1",
      provider: "test-provider",
      providerRequestId: "provider-request-1",
      providerCorrelationId: "provider-correlation-1",
      safetyBinding,
    });
    expect(reopened.state).toBe("observing");
    expect(reopened.terminalStatus).toBeUndefined();
    expect(reopened.receiptKey).toBeUndefined();

    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_owner_and_request_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("requestId", "request-1"),
        )
        .take(20),
    );
    expect(audit.map((event) => event.eventType)).toEqual([
      "external.reconciliation.resolved",
      "external.reconciliation.same-operation-resumed",
    ]);
    expect(audit[0]?.payload).toMatchObject({
      terminalStatus: "no-effect",
      evidenceDigest: "github-no-effect-evidence",
    });
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
    vi.useFakeTimers({ now });
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

    const evidence = await t.run((ctx) =>
      ctx.db
        .query("externalReconciliations")
        .withIndex("by_owner_and_reconciliation_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("reconciliationId", "reconciliation-1"),
        )
        .unique(),
    );
    expect(evidence?.safetyBinding?.version).toBe("jarvis-safety-binding:v1");
    const receiptEvidence = await t.run((ctx) =>
      ctx.db
        .query("toolExecutionReceipts")
        .withIndex("by_owner_and_receipt_key", (q) =>
          q.eq("ownerId", OWNER_ID).eq("receiptKey", "receipt-key-1"),
        )
        .unique(),
    );
    expect(receiptEvidence?.safetyBinding?.phase).toBe("tool-execute");
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
    vi.useFakeTimers({ now });
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
    vi.useFakeTimers({ now });
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
    vi.useFakeTimers({ now });
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

it("does not expose a claimed worker capability through owner read APIs", async () => {
  const t = harness();
  await t.run((ctx) =>
    seedClaimedReconciliation(ctx, {
      leaseOwner: "private-worker",
      leaseToken: "private-worker-capability",
      leaseExpiresAt: Date.now() + 60000,
    }),
  );
  const scope = {
    serviceToken: SERVICE_TOKEN,
    projectId: "project-1",
    tool: "quotes",
    operation: "send",
    idempotencyKey: "idempotency-1",
    effectFingerprint: "effect-fingerprint-1",
  };
  const responses = [
    await t.query(api.externalReconciliations.getByScope, scope),
    await t.query(api.externalReconciliations.getForOperator, {
      serviceToken: SERVICE_TOKEN,
      reconciliationId: "reconciliation-1",
    }),
    await t.query(api.externalReconciliations.listForOperator, { serviceToken: SERVICE_TOKEN }),
    await t.query(api.externalReconciliations.listForOperator, {
      serviceToken: SERVICE_TOKEN,
      state: "claimed",
    }),
  ];
  for (const response of responses) {
    expect(JSON.stringify(response)).not.toContain("private-worker-capability");
    expect(JSON.stringify(response)).not.toContain("private-worker");
  }
  const stored = await t.run((ctx) => ctx.db.query("externalReconciliations").first());
  expect(stored?.leaseToken).toBe("private-worker-capability");
});

it("keeps existing capabilities private in ordinary attempt mutation responses", async () => {
  for (const terminal of [false, true]) {
    const t = harness();
    await t.run((ctx) =>
      seedClaimedReconciliation(ctx, {
        leaseOwner: "private-worker",
        leaseToken: "private-capability",
        leaseExpiresAt: Date.now() + 60000,
      }),
    );
    const args = {
      serviceToken: SERVICE_TOKEN,
      projectId: "project-1",
      tool: "quotes",
      operation: "send",
      idempotencyKey: "idempotency-1",
      effectFingerprint: "effect-fingerprint-1",
      reconciliationId: "reconciliation-1",
      executionKey: "execution-1",
      actionId: "action-1",
      requestId: "request-1",
      actionFingerprint: "receipt-key-1-fingerprint",
      expectedProvider: "test-provider",
      receiptKey: "receipt-key-1",
      receipt: {
        receiptId: "receipt-key-1-receipt",
        actionId: "action-1",
        requestId: "request-1",
        projectId: "project-1",
        idempotencyKey: "idempotency-1",
        actionFingerprint: "receipt-key-1-fingerprint",
        tool: "quotes",
        operation: "send",
        actor: "tool" as const,
        policyVersion: "test",
        correlationId: "correlation-1",
        source: "test",
        status: terminal ? ("succeeded" as const) : ("indeterminate" as const),
        startedAt: Date.now(),
        completedAt: Date.now(),
        safetyBinding,
      },
    };
    const response = await t.mutation(
      terminal
        ? api.externalReconciliations.completeAttempt
        : api.externalReconciliations.markIndeterminate,
      args,
    );
    expect(JSON.stringify(response)).not.toContain("private-capability");
    expect(JSON.stringify(response)).not.toContain("private-worker");
    expect(
      (await t.run((ctx) => ctx.db.query("externalReconciliations").first()))?.leaseToken,
    ).toBe("private-capability");
  }
});

describe("lease/authority timing is server-side only", () => {
  it("rejects a caller-supplied now on claimNext, resolveClaim, and releaseClaim", async () => {
    const t = harness();
    const now = Date.now();
    await t.run((ctx) =>
      seedClaimedReconciliation(ctx, {
        leaseExpiresAt: now + 30_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      }),
    );

    // An attacker with a valid service token must not be able to skew any of these
    // lease/fencing decisions by injecting a `now` argument -- Convex's argument
    // validation rejects it outright since the mutations no longer declare it.
    await expect(
      t.mutation(api.externalReconciliations.claimNext, {
        serviceToken: SERVICE_TOKEN,
        workerId: "worker-B",
        leaseToken: "lease-token-B",
        leaseMs: 30_000,
        ...({ now: now + 10_000_000 } as Record<string, unknown>),
      }),
    ).rejects.toThrow();

    await expect(
      t.mutation(api.externalReconciliations.resolveClaim, {
        serviceToken: SERVICE_TOKEN,
        reconciliationId: "reconciliation-1",
        workerId: "worker-A",
        leaseToken: "lease-token-A",
        result: { status: "succeeded", outputDigest: "digest" },
        ...({ now: now + 10_000_000 } as Record<string, unknown>),
      }),
    ).rejects.toThrow();

    await expect(
      t.mutation(api.externalReconciliations.releaseClaim, {
        serviceToken: SERVICE_TOKEN,
        reconciliationId: "reconciliation-1",
        workerId: "worker-A",
        leaseToken: "lease-token-A",
        errorCode: "still-processing",
        nextAttemptAt: now + 5_000,
        maxAttempts: 5,
        ...({ now: now + 10_000_000 } as Record<string, unknown>),
      }),
    ).rejects.toThrow();
  });

  it("claims with a lease expiry bounded tightly around the server's real clock", async () => {
    const t = harness();
    const beforeCall = Date.now();
    const recordId = await t.run((ctx) =>
      seedClaimedReconciliation(ctx, {
        leaseExpiresAt: beforeCall - 1_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      }),
    );

    const claim = await t.mutation(api.externalReconciliations.claimNext, {
      serviceToken: SERVICE_TOKEN,
      workerId: "worker-B",
      leaseToken: "lease-token-B",
      leaseMs: 30_000,
    });
    const afterCall = Date.now();

    expect(claim).not.toBeNull();
    expect(claim?.reconciliation._id).toBe(recordId);
    expect(claim?.reconciliation.leaseExpiresAt).toBeGreaterThanOrEqual(beforeCall + 30_000);
    expect(claim?.reconciliation.leaseExpiresAt).toBeLessThanOrEqual(afterCall + 30_000);
  });
});

describe("releaseClaim retry-scheduling latency boundary", () => {
  it("clamps a stale worker-computed nextAttemptAt forward instead of rejecting the release", async () => {
    const t = harness();
    const claimTime = Date.now();
    await t.run((ctx) =>
      seedClaimedReconciliation(ctx, {
        leaseExpiresAt: claimTime + 60_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      }),
    );

    // Simulate the worker computing its retry-scheduling hint, then ordinary RPC
    // latency elapsing before the server receives the release call: by the time this
    // mutation runs, the server's own now has already passed the worker's hint. The
    // lease itself (checked above via assertLease inside the mutation) is still
    // genuinely valid, so the release must succeed with the stored retry time clamped
    // forward -- not reject and strand the reconciliation until lease expiry.
    const staleHint = claimTime - 1;
    const released = await t.mutation(api.externalReconciliations.releaseClaim, {
      serviceToken: SERVICE_TOKEN,
      reconciliationId: "reconciliation-1",
      workerId: "worker-A",
      leaseToken: "lease-token-A",
      errorCode: "provider-still-processing",
      nextAttemptAt: staleHint,
      maxAttempts: 5,
    });

    expect(released.state).toBe("pending");
    // Compare against claimTime (captured before the call), not a freshly resampled
    // Date.now() -- the clamp target is only a 1ms epsilon past the mutation's own
    // now, so a post-call Date.now() sample can tie with it at millisecond
    // resolution. Time only moves forward, so the mutation's internal now is always
    // >= claimTime, making this comparison both correct and deterministic.
    expect(released.nextAttemptAt).toBeGreaterThan(claimTime);
    expect(released.nextAttemptAt).not.toBe(staleHint);
  });

  it("does not stretch a short, genuinely-future retry hint out to an arbitrary floor", async () => {
    // A worker configured with a small maxRetryMs (fast retries) computes a hint only
    // a few milliseconds past now -- this is not stale, so the clamp must not silently
    // override that worker's own retry cadence with a larger minimum gap.
    const t = harness();
    const claimTime = Date.now();
    await t.run((ctx) =>
      seedClaimedReconciliation(ctx, {
        leaseExpiresAt: claimTime + 60_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      }),
    );

    const shortHint = claimTime + 500;
    const released = await t.mutation(api.externalReconciliations.releaseClaim, {
      serviceToken: SERVICE_TOKEN,
      reconciliationId: "reconciliation-1",
      workerId: "worker-A",
      leaseToken: "lease-token-A",
      errorCode: "provider-still-processing",
      nextAttemptAt: shortHint,
      maxAttempts: 5,
    });

    expect(released.state).toBe("pending");
    expect(released.nextAttemptAt).toBe(shortHint);
  });

  it("still fails closed when the lease has genuinely expired", async () => {
    const t = harness();
    const now = Date.now();
    await t.run((ctx) =>
      seedClaimedReconciliation(ctx, {
        leaseExpiresAt: now - 1_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      }),
    );

    await expect(
      t.mutation(api.externalReconciliations.releaseClaim, {
        serviceToken: SERVICE_TOKEN,
        reconciliationId: "reconciliation-1",
        workerId: "worker-A",
        leaseToken: "lease-token-A",
        errorCode: "provider-still-processing",
        nextAttemptAt: now + 5_000,
        maxAttempts: 5,
      }),
    ).rejects.toThrow("Reconciliation claim lease is stale or belongs to another worker.");
  });

  it("still escalates once max attempts is reached, regardless of the scheduling hint", async () => {
    const t = harness();
    const now = Date.now();
    await t.run((ctx) =>
      seedClaimedReconciliation(ctx, {
        leaseExpiresAt: now + 60_000,
        leaseOwner: "worker-A",
        leaseToken: "lease-token-A",
      }),
    );

    const released = await t.mutation(api.externalReconciliations.releaseClaim, {
      serviceToken: SERVICE_TOKEN,
      reconciliationId: "reconciliation-1",
      workerId: "worker-A",
      leaseToken: "lease-token-A",
      errorCode: "provider-still-processing",
      nextAttemptAt: now - 1,
      maxAttempts: 1,
    });

    expect(released.state).toBe("escalated");
  });
});
