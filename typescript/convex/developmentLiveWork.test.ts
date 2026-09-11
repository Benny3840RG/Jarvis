import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "development-live-work-test-service-token-000";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function insertSubject(
  t: ReturnType<typeof harness>,
  input: {
    subjectId: string;
    state: string;
    updatedAt: number;
    repository?: string;
    branch?: string;
    orchestrationRunId?: string;
    orchestrationNodeId?: string;
  },
) {
  await t.run((ctx) =>
    ctx.db.insert("developmentSubjects", {
      ownerId: "jarvis-cli",
      subjectId: input.subjectId,
      state: input.state as never,
      subjectVersion: 0,
      projectionVersion: 0,
      reducerVersion: "DevelopmentReducer/v1",
      ...(input.orchestrationRunId ? { orchestrationRunId: input.orchestrationRunId } : {}),
      ...(input.orchestrationNodeId ? { orchestrationNodeId: input.orchestrationNodeId } : {}),
      omegaMissionId: input.subjectId,
      ...(input.repository ? { repository: input.repository } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    }),
  );
}

describe("developmentState.liveWork", () => {
  it("returns null when this owner has no development subjects", async () => {
    const t = harness();
    expect(
      await t.query(api.developmentState.liveWork, { serviceToken: SERVICE_TOKEN }),
    ).toBeNull();
  });

  it("rejects an invalid service token", async () => {
    const t = harness();
    await expect(
      t.query(api.developmentState.liveWork, { serviceToken: "wrong-token" }),
    ).rejects.toThrow(/service token/i);
  });

  it("picks the most-recently-updated non-terminal subject over a newer terminal one", async () => {
    const t = harness();
    await insertSubject(t, { subjectId: "mission-old", state: "REVIEW", updatedAt: 1_000 });
    await insertSubject(t, { subjectId: "mission-new", state: "COMPLETE", updatedAt: 9_000 });

    const snapshot = await t.query(api.developmentState.liveWork, { serviceToken: SERVICE_TOKEN });
    expect(snapshot?.subject.subjectId).toBe("mission-old");
    expect(snapshot?.subject.state).toBe("REVIEW");
  });

  it("returns idle when every subject is terminal", async () => {
    const t = harness();
    await insertSubject(t, { subjectId: "mission-a", state: "COMPLETE", updatedAt: 1_000 });
    await insertSubject(t, { subjectId: "mission-b", state: "ABORTED", updatedAt: 5_000 });

    const snapshot = await t.query(api.developmentState.liveWork, { serviceToken: SERVICE_TOKEN });
    expect(snapshot).toBeNull();
  });

  it("rejects ambiguous active missions rather than selecting by recency", async () => {
    const t = harness();
    await insertSubject(t, { subjectId: "a", state: "BUILDING", updatedAt: 1 });
    await insertSubject(t, { subjectId: "b", state: "MERGED", updatedAt: 2 });
    await expect(
      t.query(api.developmentState.liveWork, { serviceToken: SERVICE_TOKEN }),
    ).rejects.toThrow(/AMBIGUOUS/i);
  });

  it("does not infer an Omega binding from a matching mission id", async () => {
    const t = harness();
    await insertSubject(t, { subjectId: "unbound", state: "MERGED", updatedAt: 1 });
    await t.run(async (ctx) => {
      const subject = await ctx.db.query("developmentSubjects").first();
      await ctx.db.patch("developmentSubjects", subject!._id, { omegaMissionId: undefined });
      await ctx.db.insert("omegaMissions", {
        ownerId: "jarvis-cli",
        missionId: "unbound",
        projectKey: "jarvis",
        objective: "Unrelated same-id mission",
        state: "active",
        riskClass: "R2",
        autonomyClass: "A2",
        reversibilityClass: "REV-2",
        uncertaintyBudget: 0.2,
        acceptanceCriteria: [],
        policyVersion: "omega-policy:v1",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const snapshot = await t.query(api.developmentState.liveWork, { serviceToken: SERVICE_TOKEN });
    expect(snapshot?.omegaMission).toBeNull();
    expect(snapshot?.omegaReadiness).toEqual({
      allowed: false,
      failures: ["omega-mission-not-linked"],
    });
  });

  it("reads the newest forty events even when lifetime history exceeds the list limit", async () => {
    const t = harness();
    await insertSubject(t, { subjectId: "long-run", state: "BUILDING", updatedAt: 1 });
    await t.run(async (ctx) => {
      for (let i = 0; i < 1001; i++) {
        await ctx.db.insert("developmentEvents", {
          ownerId: "jarvis-cli",
          subjectId: "long-run",
          eventId: `event-${i}`,
          requestId: `request-${i}`,
          canonicalRequestFingerprint: `request-fingerprint-${i}`,
          canonicalEventFingerprint: `event-fingerprint-${i}`,
          eventType: "DEV_TRANSITION_REJECTED",
          eventSchemaVersion: 1,
          occurredAt: new Date(i).toISOString(),
          recordedAt: new Date(i).toISOString(),
          evidenceIds: [],
          correlationId: "correlation-long-run",
          reducerVersion: "DevelopmentReducer/v1",
          payload: { reasonCodes: ["test-rejection"] },
          createdAt: i,
        });
      }
    });
    const snapshot = await t.query(api.developmentState.liveWork, { serviceToken: SERVICE_TOKEN });
    expect(snapshot?.events.map((event) => event.eventId)).toEqual(
      Array.from({ length: 40 }, (_, i) => `event-${i + 961}`),
    );
  });

  it("does not hide active work behind fifty terminal subjects", async () => {
    const t = harness();
    await insertSubject(t, { subjectId: "active", state: "MERGED", updatedAt: 1 });
    for (let i = 0; i < 51; i++) {
      await insertSubject(t, { subjectId: `terminal-${i}`, state: "COMPLETE", updatedAt: i + 2 });
    }
    expect(
      (await t.query(api.developmentState.liveWork, { serviceToken: SERVICE_TOKEN }))?.subject
        .subjectId,
    ).toBe("active");
  });

  it("projects events with safe fields and joins the Omega mission", async () => {
    const t = harness();
    await insertSubject(t, {
      subjectId: "mission-1",
      state: "READY_TO_MERGE",
      updatedAt: 2_000,
      repository: "Benny3840RG/Jarvis",
      branch: "agent/mission-1",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("omegaMissions", {
        ownerId: "jarvis-cli",
        missionId: "mission-1",
        projectKey: "jarvis",
        objective: "Ship the live-work HUD",
        state: "active",
        riskClass: "R2",
        autonomyClass: "A2",
        reversibilityClass: "REV-2",
        uncertaintyBudget: 0.2,
        acceptanceCriteria: [
          { criterionId: "c1", statement: "tests pass", status: "satisfied", evidenceRefs: [] },
          { criterionId: "c2", statement: "reviewed", status: "unverified", evidenceRefs: [] },
        ],
        policyVersion: "omega-policy:v1",
        createdAt: 1_000,
        updatedAt: 2_000,
      });
      await ctx.db.insert("developmentEvents", {
        ownerId: "jarvis-cli",
        subjectId: "mission-1",
        eventId: "event-1",
        requestId: "request-1",
        canonicalRequestFingerprint: "fp-request-1",
        canonicalEventFingerprint: "fp-event-1",
        eventType: "DEV_TRANSITION_COMMITTED",
        eventSchemaVersion: 1,
        transitionId: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE",
        occurredAt: "2026-09-01T00:00:00.000Z",
        recordedAt: "2026-09-01T00:00:00.000Z",
        evidenceIds: [],
        correlationId: "correlation-1",
        reducerVersion: "DevelopmentReducer/v1",
        payload: { from: "REVIEW", to: "READY_TO_MERGE", mergeReceiptKey: "receipt-1" },
        createdAt: 1_500,
      });
    });

    const snapshot = await t.query(api.developmentState.liveWork, { serviceToken: SERVICE_TOKEN });
    expect(snapshot?.omegaMission).toEqual({
      missionId: "mission-1",
      objective: "Ship the live-work HUD",
      state: "active",
      acceptanceCriteria: [{ status: "satisfied" }, { status: "unverified" }],
    });
    expect(snapshot?.events).toEqual([
      {
        eventId: "event-1",
        eventType: "DEV_TRANSITION_COMMITTED",
        transitionId: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE",
        occurredAt: "2026-09-01T00:00:00.000Z",
        from: "REVIEW",
        to: "READY_TO_MERGE",
        reasonCodes: [],
        hasMergeReceipt: true,
      },
    ]);
  });

  it("projects the orchestration worker step without its lease token", async () => {
    const t = harness();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("orchestrationRuns", {
        ownerId: "jarvis-cli",
        runId: "run-1",
        triggerId: "trigger-run-1",
        triggerSource: "http",
        triggerKind: "github-development-mission",
        idempotencyKey: "github:run-1",
        requestFingerprint: "request-run-1",
        planFingerprint: "plan-run-1",
        triggerPayload: {},
        authority: "T2",
        policyVersion: "development-policy:v1",
        policyFingerprint: "development-policy-fingerprint:v1",
        nodeIds: ["development"],
        completedStepIds: [],
        checkpointSequence: 1,
        state: "running",
        retryCount: 0,
        maxRetries: 2,
        recoveryState: "none",
        recoveryEvidence: [],
        checkpointNodeId: "development",
        checkpointAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("orchestrationSteps", {
        ownerId: "jarvis-cli",
        runId: "run-1",
        nodeId: "development",
        operationId: "github-development-worker",
        state: "running",
        attempt: 1,
        retryable: true,
        updatedAt: now,
        leaseOwner: "worker-7",
        leaseToken: "secret-lease-token",
        leaseFencingToken: 1,
        leaseExpiresAt: now + 60_000,
      });
    });
    await insertSubject(t, {
      subjectId: "mission-1",
      state: "BUILDING",
      updatedAt: now,
      orchestrationRunId: "run-1",
      orchestrationNodeId: "development",
    });

    const snapshot = await t.query(api.developmentState.liveWork, { serviceToken: SERVICE_TOKEN });
    expect(snapshot?.workerStep?.leaseOwner).toBe("worker-7");
    expect(snapshot?.workerStep?.operationId).toBe("github-development-worker");
    expect(JSON.stringify(snapshot)).not.toContain("secret-lease-token");
  });
});
