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
