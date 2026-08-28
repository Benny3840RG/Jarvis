import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "tool-actions-consent-test-service-token-0000";
const APPROVAL_TOKEN = "tool-actions-human-approval-token-0000000";
const DELIVERY_RUNTIME_TOKEN = "tool-actions-delivery-runtime-token-0000000";
const OWNER_ID = "jarvis-cli";
const PROJECT_KEY = "project-1";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", APPROVAL_TOKEN);
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
  it("rejects a service-token caller that bypasses the HTTP approval boundary", async () => {
    const t = harness();
    await stageAndReturn(t);

    await expect(
      t.mutation(api.toolActions.approve, {
        serviceToken: SERVICE_TOKEN,
        approvalToken: "",
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/approval token/i);

    const approved = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
    });
    expect(approved.state).toBe("approved");
  });

  it("rejects approval when current or rotation credentials collide across control-plane roles", async () => {
    const collisionCases = [
      ["JARVIS_DELIVERY_RUNTIME_TOKEN", APPROVAL_TOKEN],
      ["JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS", APPROVAL_TOKEN],
      ["JARVIS_APPROVAL_TOKEN_PREVIOUS", DELIVERY_RUNTIME_TOKEN],
    ] as const;

    for (const [name, value] of collisionCases) {
      const t = harness();
      vi.stubEnv(name, value);
      await stageAndReturn(t);

      await expect(
        t.mutation(api.toolActions.approve, {
          serviceToken: SERVICE_TOKEN,
          approvalToken: APPROVAL_TOKEN,
          projectKey: PROJECT_KEY,
          actionId: "action-1",
          expectedRevision: 1,
        }),
      ).rejects.toThrow(/distinct from service and peer runtime credentials/i);

      vi.unstubAllEnvs();
      vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
      vi.stubEnv("JARVIS_APPROVAL_TOKEN", APPROVAL_TOKEN);
      vi.stubEnv("JARVIS_DELIVERY_RUNTIME_TOKEN", DELIVERY_RUNTIME_TOKEN);
    }
  });

  it("persists an immutable safety binding on each consent transition and audit record", async () => {
    const t = harness();
    const staged = await stageAndReturn(t);
    expect(staged.safetyBinding?.version).toBe("jarvis-safety-binding:v1");

    const approved = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now: Date.now(),
    });
    expect(approved.safetyBinding?.phase).toBe("tool-approve");

    const revoked = await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "No longer required.",
      now: Date.now(),
    });
    expect(revoked.safetyBinding?.phase).toBe("tool-revoke");

    const auditRows = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_owner_and_request_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("requestId", "request-1"),
        )
        .collect(),
    );
    const lifecycleRows = auditRows.filter((row) => row.eventType.startsWith("tool.action."));
    expect(lifecycleRows).toHaveLength(3);
    expect(
      lifecycleRows.every(
        (row) => row.payload.safetyBinding?.version === "jarvis-safety-binding:v1",
      ),
    ).toBe(true);
    expect(JSON.stringify(lifecycleRows).includes("title")).toBe(false);
  });

  it("stamps the durable binding when an expired approval is observed", async () => {
    const t = harness();
    await stageAndReturn(t);
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now: 1_000,
      approvalTtlMs: 60_000,
    });

    const expired = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now: 61_001,
    });
    expect(expired.state).toBe("expired");
    expect(expired.safetyBinding?.phase).toBe("tool-approve");
    expect(expired.safetyBinding?.version).toBe("jarvis-safety-binding:v1");
  });

  it("stamps a ttl expiry policy and a reusable consumption policy for a non-destructive proposal", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();

    const approved = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const second = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const wayLater = now + 365 * 24 * 60 * 60 * 1000;
    const result = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    const expiresAt = approved.approvalExpiresAt as number;

    const result = await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const revoked = await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    const first = await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "Changed my mind.",
      now,
    });

    const second = await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "First reason.",
      now,
    });

    await expect(
      t.mutation(api.toolActions.revoke, {
        serviceToken: SERVICE_TOKEN,
        approvalToken: APPROVAL_TOKEN,
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
        approvalToken: APPROVAL_TOKEN,
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
        approvalToken: APPROVAL_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        reason: "Too late.",
      }),
    ).rejects.toThrow(/cannot be revoked|not approved/i);
  });

  it("refuses to revoke a single-use action that already has a completed execution receipt", async () => {
    // This is the authoritative-winner proof for a revocation racing an
    // execution: whichever terminal fact commits first wins. If the
    // execution already produced a completed receipt (succeeded, failed, or
    // indeterminate), the action is already consumed — revoke() must not
    // silently accept a request that can no longer have any effect on an
    // external side effect that may already have happened.
    const t = harness();
    const action = await stageAndReturn(t, { destructive: true, requiredAuthority: "T3" });
    expect(action.consumptionPolicy).toBeUndefined();
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    await t.run((ctx) =>
      ctx.db.insert("toolExecutionReceipts", {
        ownerId: OWNER_ID,
        receiptKey: `${PROJECT_KEY}:action-1:live`,
        receiptId: "receipt-1",
        actionId: "action-1",
        requestId: "request-1",
        projectId: PROJECT_KEY,
        idempotencyKey: "tool-action-execution:v1:live:already-executed",
        actionFingerprint: "jarvis-action-fingerprint:v1:test",
        tool: "notes",
        operation: "create",
        status: "succeeded",
        startedAt: now,
        completedAt: now,
        createdAt: now,
      }),
    );

    await expect(
      t.mutation(api.toolActions.revoke, {
        serviceToken: SERVICE_TOKEN,
        approvalToken: APPROVAL_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        reason: "Too late — already executed.",
        now,
      }),
    ).rejects.toThrow(/already consumed/i);

    const stillApproved = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
    });
    expect(stillApproved?.state).toBe("approved");
  });

  it("allows revoking a reusable action that already has a completed execution receipt", async () => {
    // Independent review finding: the operator doc's blanket "refuses to
    // revoke an action that has already produced a completed execution
    // receipt" claim, read without qualification, contradicts this
    // repository's own design — revoke()'s completed-receipt refusal above
    // only ever applies to single-use actions (see the `consumptionPolicy
    // === "single-use"` guard on the check). A reusable action has no
    // single-attempt invariant to protect, so it must remain revocable
    // (stopping only the *next* attempt) no matter how many completed
    // receipts already exist. This pins that contract to real behavior.
    const t = harness();
    const action = await stageAndReturn(t, { destructive: false });
    expect(action.consumptionPolicy).toBeUndefined();
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    await t.run((ctx) =>
      ctx.db.insert("toolExecutionReceipts", {
        ownerId: OWNER_ID,
        receiptKey: `${PROJECT_KEY}:action-1:live`,
        receiptId: "receipt-1",
        actionId: "action-1",
        requestId: "request-1",
        projectId: PROJECT_KEY,
        idempotencyKey: "tool-action-execution:v1:live:already-executed-reusable",
        actionFingerprint: "jarvis-action-fingerprint:v1:test",
        tool: "notes",
        operation: "create",
        status: "succeeded",
        startedAt: now,
        completedAt: now,
        createdAt: now,
      }),
    );

    const revoked = await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "Stop further sends; the one that already ran is fine.",
      now,
    });

    expect(revoked.state).toBe("revoked");
  });

  it("never deletes the action or its audit evidence", async () => {
    const t = harness();
    await stageAndReturn(t);
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
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
        approvalToken: APPROVAL_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "other-owner-action",
        reason: "Attempting cross-owner revoke.",
      }),
    ).rejects.toThrow(/does not exist/i);

    await expect(
      t.mutation(api.toolActions.approve, {
        serviceToken: SERVICE_TOKEN,
        approvalToken: APPROVAL_TOKEN,
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
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const results = await Promise.allSettled([
      t.mutation(api.toolActions.revoke, {
        serviceToken: SERVICE_TOKEN,
        approvalToken: APPROVAL_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        reason: "Reason A",
        now,
      }),
      t.mutation(api.toolActions.revoke, {
        serviceToken: SERVICE_TOKEN,
        approvalToken: APPROVAL_TOKEN,
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

  it("two concurrent single-use execution claims with different claim IDs produce exactly one winner", async () => {
    const t = harness();
    await stageAndReturn(t, { destructive: true, requiredAuthority: "T3" });
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const results = await Promise.all([
      t.mutation(api.toolActions.claimSingleUseExecution, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        claimId: "claim-a",
        now,
      }),
      t.mutation(api.toolActions.claimSingleUseExecution, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        claimId: "claim-b",
        now,
      }),
    ]);

    const winners = results.filter((result) => result.claimed);
    expect(winners).toHaveLength(1);
    // Convex's OCC serializes the two mutations touching the same document:
    // whichever commits first claims the row; the other observes the
    // already-set claim and reports the winner's ID rather than its own.
    const winnerClaimId = winners[0]?.claimId;
    for (const result of results) {
      expect(result.claimId).toBe(winnerClaimId);
    }

    const stored = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
    });
    expect(stored?.singleUseClaimId).toBe(winnerClaimId);
  });

  it("repeating the same claim ID is idempotent, not a second winner", async () => {
    const t = harness();
    await stageAndReturn(t, { destructive: true, requiredAuthority: "T3" });
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const first = await t.mutation(api.toolActions.claimSingleUseExecution, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      claimId: "claim-a",
      now,
    });
    const second = await t.mutation(api.toolActions.claimSingleUseExecution, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      claimId: "claim-a",
      now,
    });

    expect(first).toEqual({ claimed: true, claimId: "claim-a" });
    expect(second).toEqual({
      claimed: false,
      claimId: "claim-a",
      blockReason: "already-claimed",
    });
  });

  it("refuses to claim single-use execution once the action was revoked between the caller's read and the claim", async () => {
    // Reproduces the exact-head review finding: the HTTP boundary's own
    // `get()` can observe "approved" before an operator revokes the action,
    // then a delayed claimSingleUseExecution call must not still succeed
    // just because the *caller's* earlier snapshot said "approved". The
    // claim mutation's own fresh read must be authoritative.
    const t = harness();
    await stageAndReturn(t, { destructive: true, requiredAuthority: "T3" });
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "Operator changed their mind before execution.",
      now,
    });

    const claim = await t.mutation(api.toolActions.claimSingleUseExecution, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      claimId: "claim-a",
      now,
    });

    expect(claim).toEqual({ claimed: false, claimId: "", blockReason: "not-approved" });
    const stored = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
    });
    // The claim attempt must not disturb the revoked state or set a claim.
    expect(stored?.state).toBe("revoked");
    expect(stored?.singleUseClaimId).toBeUndefined();
  });

  it("refuses to claim single-use execution once the approval expired between the caller's read and the claim, and durably observes the expiry", async () => {
    const t = harness();
    await stageAndReturn(t, { destructive: true, requiredAuthority: "T3" });
    const approvedAt = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now: approvedAt,
      approvalTtlMs: 60_000, // clamped to the 1-minute floor
    });

    // The caller's own earlier read (not modelled here) would have seen
    // "approved, not yet expired" at approvedAt. By the time the claim is
    // attempted, the TTL has elapsed.
    const claimAttemptAt = approvedAt + 60_001;
    const claim = await t.mutation(api.toolActions.claimSingleUseExecution, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      claimId: "claim-a",
      now: claimAttemptAt,
    });

    expect(claim).toEqual({ claimed: false, claimId: "", blockReason: "expired" });
    const stored = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
    });
    // Expiry is durably observed, matching approve()'s own lazy-expiry
    // convention, not just reported transiently for this one call.
    expect(stored?.state).toBe("expired");
    expect(stored?.singleUseClaimId).toBeUndefined();
  });

  it("refuses to claim single-use execution for a reusable action", async () => {
    const t = harness();
    await stageAndReturn(t, { destructive: false });
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    await expect(
      t.mutation(api.toolActions.claimSingleUseExecution, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        claimId: "claim-a",
        now,
      }),
    ).rejects.toThrow(/single-use/i);
  });

  it("refuses execution eligibility for a reusable action once it was revoked between the caller's read and the check", async () => {
    // Full-repo-audit finding: reusable actions had no equivalent of
    // claimSingleUseExecution's authoritative re-check — execute() trusted
    // the caller's own, separately-fetched, potentially stale snapshot. A
    // revoke landing between that read and the execute call must still be
    // caught here, exactly as it already is for single-use actions above.
    const t = harness();
    await stageAndReturn(t, { destructive: false });
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });
    await t.mutation(api.toolActions.revoke, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      reason: "Operator changed their mind before execution.",
      now,
    });

    const verification = await t.mutation(api.toolActions.verifyExecutionEligibility, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      now,
    });

    expect(verification).toEqual({ eligible: false, blockReason: "not-approved" });
    const stored = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
    });
    expect(stored?.state).toBe("revoked");
  });

  it("refuses execution eligibility for a reusable action once its approval expired between the caller's read and the check, and durably observes the expiry", async () => {
    const t = harness();
    await stageAndReturn(t, { destructive: false });
    const approvedAt = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now: approvedAt,
      approvalTtlMs: 60_000, // clamped to the 1-minute floor
    });

    const checkAt = approvedAt + 60_001;
    const verification = await t.mutation(api.toolActions.verifyExecutionEligibility, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      now: checkAt,
    });

    expect(verification).toEqual({ eligible: false, blockReason: "expired" });
    const stored = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
    });
    // Expiry is durably observed, matching approve()'s and
    // claimSingleUseExecution's own lazy-expiry convention.
    expect(stored?.state).toBe("expired");
  });

  it("reports execution eligibility for a still-approved reusable action without disturbing its state", async () => {
    const t = harness();
    await stageAndReturn(t, { destructive: false });
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    const verification = await t.mutation(api.toolActions.verifyExecutionEligibility, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      now,
    });

    expect(verification).toEqual({ eligible: true });
    const stored = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
    });
    expect(stored?.state).toBe("approved");
  });

  it("refuses execution eligibility checks for a single-use action", async () => {
    const t = harness();
    await stageAndReturn(t, { destructive: true, requiredAuthority: "T3" });
    const now = Date.now();
    await t.mutation(api.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      expectedRevision: 1,
      now,
    });

    await expect(
      t.mutation(api.toolActions.verifyExecutionEligibility, {
        serviceToken: SERVICE_TOKEN,
        projectKey: PROJECT_KEY,
        actionId: "action-1",
        now,
      }),
    ).rejects.toThrow(/single-use/i);
  });
});
