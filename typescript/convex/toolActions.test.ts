import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "tool-actions-consent-test-service-token-0000";
const OWNER_ID = "jarvis-cli";
const PROJECT_KEY = "project-1";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedProject(ctx: MutationCtx, revision = 1) {
  return ctx.db.insert("projects", {
    ownerId: OWNER_ID,
    projectKey: PROJECT_KEY,
    projectName: "Test project",
    projectType: "test",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision,
    domains: ["home"],
    summary: "Test project for consent-lifecycle coverage.",
    preferences: {
      outputStyle: "concise",
      communicationTone: "neutral",
      detailLevel: "standard",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
}

function stageArgs(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    serviceToken: SERVICE_TOKEN,
    actionId: "action-1",
    requestId: "request-1",
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    tool: "notes",
    operation: "create",
    arguments: { title: "Test" },
    rationale: "Testing the consent lifecycle.",
    requiredAuthority: "T2" as const,
    destructive: false,
    idempotencyKey: "idempotency-1",
    proposedBy: "agent" as const,
    ...overrides,
  };
}

async function stageAndReturn(t: ReturnType<typeof harness>, overrides = {}) {
  await t.run((ctx) => seedProject(ctx));
  return t.mutation(api.toolActions.stage, stageArgs(overrides));
}

describe("approve() consent-lifecycle stamping", () => {
  it("stamps a ttl expiry policy and a reusable consumption policy for a non-destructive proposal", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();

    const approved = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    expect(approved.approvalExpiryPolicy).toBe("ttl");
    expect(approved.approvalExpiresAt).toBeGreaterThan(now);
    expect(approved.consumptionPolicy).toBe("reusable");
  });

  it("stamps a tighter expiry ceiling and single-use consumption for a destructive proposal", async () => {
    const t = harness();
    await t.run((ctx) => seedProject(ctx));
    await t.mutation(
      api.toolActions.stage,
      stageArgs({ destructive: true, requiredAuthority: "T3" }),
    );
    const now = Date.now();

    const nonDestructiveNow = Date.now();
    const approved = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    expect(approved.consumptionPolicy).toBe("single-use");
    expect(approved.approvalExpiresAt).toBeLessThanOrEqual(now + 60 * 60 * 1000);
    void nonDestructiveNow;
  });

  it("clamps a caller-supplied approvalTtlMs override rather than trusting it verbatim", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();

    const approved = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
      approvalTtlMs: Number.MAX_SAFE_INTEGER,
    });

    expect(approved.approvalExpiresAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(approved.approvalExpiresAt).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000);
  });
});

describe("approve() expiry observation on idempotent re-approve", () => {
  it("silently returns the unchanged doc when re-approved before expiry", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    const first = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const second = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now: now + 1000,
    });

    expect(second._id).toBe(first._id);
    expect(second.approvalExpiresAt).toBe(first.approvalExpiresAt);
    expect(second.state).toBe("approved");
  });

  it("persists the expired transition and returns the expired doc, not a stale approved one", async () => {
    // Convex mutations are all-or-nothing transactions: a write followed by
    // a throw in the same call rolls the write back. So the durable
    // "expired" transition must be observable via the *returned* doc (and a
    // subsequent read), not via a thrown rejection from this call — exactly
    // like reject()'s own idempotent-match path already returns rather than
    // throws.
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const wayLater = now + 365 * 24 * 60 * 60 * 1000;
    const result = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now: wayLater,
    });
    expect(result.state).toBe("expired");
    expect(result.expiredObservedAt).toBe(wayLater);

    const stored = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
    });
    expect(stored?.state).toBe("expired");
    expect(stored?.expiredObservedAt).toBe(wayLater);
  });

  it("boundary: now === approvalExpiresAt is already expired, not one more valid instant", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    const approved = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    const expiresAt = approved.approvalExpiresAt as number;

    const result = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now: expiresAt,
    });
    expect(result.state).toBe("expired");
  });
});

describe("get()/listRecent() expose a computed isApprovalExpired without mutating storage", () => {
  it("reports isApprovalExpired true from a query without persisting the state transition", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const wayLater = now + 365 * 24 * 60 * 60 * 1000;
    const viaGet = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      now: wayLater,
    });
    expect(viaGet?.state).toBe("approved");
    expect(viaGet?.isApprovalExpired).toBe(true);

    const viaList = await t.query(api.toolActions.listRecent, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      now: wayLater,
    });
    expect(viaList[0]?.state).toBe("approved");
    expect(viaList[0]?.isApprovalExpired).toBe(true);

    const storedAfterQueries = await t.run((ctx) =>
      ctx.db
        .query("toolActions")
        .withIndex("by_owner_and_action_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("actionId", "action-1"),
        )
        .unique(),
    );
    expect(storedAfterQueries?.state).toBe("approved");
  });

  it("reports isApprovalExpired false for a fresh approval", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const viaGet = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      now,
    });
    expect(viaGet?.isApprovalExpired).toBe(false);
  });
});

describe("revoke()", () => {
  it("revokes an approved action, stamping actor/reason/timestamp", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const revoked = await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "Pricing changed after approval.",
      now: now + 500,
    });

    expect(revoked.state).toBe("revoked");
    expect(revoked.revokedBy).toBe("user");
    expect(revoked.revokedReason).toBe("Pricing changed after approval.");
    expect(revoked.revokedAt).toBe(now + 500);
  });

  it("is idempotent when repeated with the same reason", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    const first = await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "Changed my mind.",
      now,
    });

    const second = await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "Changed my mind.",
      now: now + 1000,
    });

    expect(second._id).toBe(first._id);
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it("throws when repeated with a different reason", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "First reason.",
      now,
    });

    await expect(
      t.mutation(api.toolActions.revoke, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        reason: "A different reason.",
        now,
      }),
    ).rejects.toThrow(/different reason/i);
  });

  it("throws when the action was never approved (still proposed)", async () => {
    const t = harness();
    await stageAndReturn(t);

    await expect(
      t.mutation(api.toolActions.revoke, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        reason: "Too early.",
      }),
    ).rejects.toThrow(/cannot be revoked|not approved/i);
  });

  it("throws when the action was rejected, not approved", async () => {
    const t = harness();
    await stageAndReturn(t);
    await t.mutation(api.toolActions.reject, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "Not needed.",
    });

    await expect(
      t.mutation(api.toolActions.revoke, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        reason: "Too late.",
      }),
    ).rejects.toThrow(/cannot be revoked|not approved/i);
  });

  it("never deletes the action or its audit evidence", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "Retracted.",
      now,
    });

    const stillThere = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
    });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.state).toBe("revoked");

    const auditRows = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_owner_and_request_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("requestId", "request-1"),
        )
        .collect(),
    );
    const eventTypes = auditRows.map((row) => row.eventType);
    expect(eventTypes).toContain("tool.action.proposed");
    expect(eventTypes).toContain("tool.action.approved");
    expect(eventTypes).toContain("tool.action.revoked");
  });

  it("does not require a revision match, unlike approve/stage", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    // Project revision has since moved on; revoke must still succeed.
    await t.run(async (ctx) => {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_owner_and_project_key", (q) =>
          q.eq("ownerId", OWNER_ID).eq("projectKey", PROJECT_KEY),
        )
        .unique();
      if (project) await ctx.db.patch("projects", project._id, { revision: 2 });
    });

    const revoked = await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "Still revocable despite the revision bump.",
      now,
    });
    expect(revoked.state).toBe("revoked");
  });
});

describe("owner isolation", () => {
  it("cannot see, approve, or revoke another owner's action", async () => {
    const t = harness();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("toolActions", {
        ownerId: "another-owner",
        actionId: "other-owner-action",
        requestId: "other-owner-request",
        projectKey: PROJECT_KEY,
        baseRevision: 1,
        state: "approved",
        tool: "notes",
        operation: "create",
        arguments: {},
        rationale: "Belongs to another owner.",
        requiredAuthority: "T2",
        destructive: false,
        idempotencyKey: "other-owner-idempotency",
        proposedBy: "agent",
        approvedBy: "user",
        createdAt: now,
        updatedAt: now,
        approvedAt: now,
      });
    });

    const viaGet = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "other-owner-action",
    });
    expect(viaGet).toBeNull();

    await expect(
      t.mutation(api.toolActions.revoke, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "other-owner-action",
        reason: "Attempting cross-owner revoke.",
      }),
    ).rejects.toThrow(/does not exist/i);

    await expect(
      t.mutation(api.toolActions.approve, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "other-owner-action",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe("concurrency: racing mutations against the same approved action", () => {
  it("two concurrent revoke calls with different reasons produce exactly one authoritative winner", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const results = await Promise.allSettled([
      t.mutation(api.toolActions.revoke, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        reason: "Reason A",
        now,
      }),
      t.mutation(api.toolActions.revoke, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        reason: "Reason B",
        now,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    // Convex's OCC serializes the two mutations: exactly one observes a clean
    // "approved -> revoked" transition and succeeds; the other observes the
    // already-revoked state under a different reason and throws.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const stored = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
    });
    expect(stored?.state).toBe("revoked");
    expect(["Reason A", "Reason B"]).toContain(stored?.revokedReason);
  });
});
