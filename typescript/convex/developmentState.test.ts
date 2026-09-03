import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { validateEventEnvelope, type JarvisEvent } from "../src/development/events.js";
import { fingerprintToolAction, fingerprintToolEffect } from "../src/actions/toolExecution.js";
import type { ToolAction } from "../src/actions/toolActions.js";
import { computeAuthorityEnvelopeHash } from "../src/development/stateMachine.js";

const SERVICE_TOKEN = "development-state-test-service-token-00000";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const missionAuthority = {
  repositories: ["Benny3840RG/Jarvis"],
  branches: ["agent/governed-dev-state-machine-phase1"],
  externalEffects: ["github.merge"],
  maxRiskClass: 3,
};

function claimedToBuildingArgs(overrides: Record<string, unknown> = {}) {
  return {
    serviceToken: SERVICE_TOKEN,
    subjectId: "mission-1",
    eventId: "event-1",
    requestId: "request-1",
    correlationId: "correlation-1",
    transitionId: "DEV_TRANSITION_CLAIMED_TO_BUILDING" as const,
    to: "BUILDING" as const,
    requestedBy: { actorType: "worker" as const, actorId: "worker-1" },
    committedBy: { actorType: "controller" as const, actorId: "development-controller" },
    workerId: "worker-1",
    lease: {
      leaseToken: "lease-token-1",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2999-09-01T01:00:00.000Z",
      fencingToken: 1,
    },
    missionAuthority,
    workerAuthority: missionAuthority,
    ...overrides,
  };
}

async function seedSubject(
  t: ReturnType<typeof harness>,
  input: {
    subjectId?: string;
    state?: "CLAIMED" | "READY" | "VERIFYING" | "REVIEW" | "READY_TO_MERGE" | "MERGED";
    fencingToken?: number;
    orchestrationRunId?: string;
    orchestrationNodeId?: string;
    repository?: string;
    branch?: string;
  } = {},
) {
  const now = Date.now();
  const subjectId = input.subjectId ?? "mission-1";
  const shouldBind = input.fencingToken !== undefined || input.orchestrationRunId !== undefined;
  const orchestrationRunId = input.orchestrationRunId ?? `${subjectId}-run`;
  const orchestrationNodeId = input.orchestrationNodeId ?? "development";
  if (shouldBind) {
    await t.run(async (ctx) => {
      const existingRun = await ctx.db
        .query("orchestrationRuns")
        .withIndex("by_owner_and_run_id", (q) =>
          q.eq("ownerId", "jarvis-cli").eq("runId", orchestrationRunId),
        )
        .unique();
      if (!existingRun) {
        await ctx.db.insert("orchestrationRuns", {
          ownerId: "jarvis-cli",
          runId: orchestrationRunId,
          triggerId: `trigger-${orchestrationRunId}`,
          triggerSource: "http",
          triggerKind: "github-development-mission",
          idempotencyKey: `github:${orchestrationRunId}`,
          requestFingerprint: `request-${orchestrationRunId}`,
          planFingerprint: `plan-${orchestrationRunId}`,
          triggerPayload: {},
          authority: input.state === "READY_TO_MERGE" ? "T3" : "T2",
          policyVersion: "development-policy:v1",
          policyFingerprint: "development-policy-fingerprint:v1",
          nodeIds: [orchestrationNodeId],
          completedStepIds: [],
          checkpointSequence: 1,
          state: "running",
          retryCount: 0,
          maxRetries: 2,
          recoveryState: "none",
          recoveryEvidence: [],
          checkpointNodeId: orchestrationNodeId,
          checkpointAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("orchestrationSteps", {
          ownerId: "jarvis-cli",
          runId: orchestrationRunId,
          nodeId: orchestrationNodeId,
          operationId: "reasonWithTotality",
          state: "running",
          attempt: 1,
          retryable: true,
          updatedAt: now,
          leaseOwner: "worker-1",
          leaseToken: `lease-token-${input.fencingToken ?? 1}`,
          leaseFencingToken: input.fencingToken ?? 1,
          leaseExpiresAt: now + 60_000,
        });
      }
    });
  }
  await t.run((ctx) =>
    ctx.db.insert("developmentSubjects", {
      ownerId: "jarvis-cli",
      subjectId,
      state: input.state ?? "CLAIMED",
      subjectVersion: 0,
      projectionVersion: 0,
      reducerVersion: "DevelopmentReducer/v1",
      ...(input.fencingToken !== undefined ? { fencingToken: input.fencingToken } : {}),
      ...(shouldBind ? { orchestrationRunId, orchestrationNodeId } : {}),
      ...(shouldBind ? { repository: input.repository ?? "Benny3840RG/Jarvis" } : {}),
      ...(shouldBind ? { branch: input.branch ?? "agent/governed-dev-state-machine-phase1" } : {}),
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function createActiveOrchestrationLease(
  t: ReturnType<typeof harness>,
  input: { runId?: string; nodeId?: string; workerId?: string } = {},
) {
  const runId = input.runId ?? "run-1";
  const nodeId = input.nodeId ?? "development";
  const workerId = input.workerId ?? "worker-1";
  await t.mutation(api.orchestrationState.beginRun, {
    serviceToken: SERVICE_TOKEN,
    runId,
    triggerId: `trigger-${runId}`,
    triggerSource: "http",
    triggerKind: "github-development-mission",
    idempotencyKey: `github:${runId}`,
    requestFingerprint: `request-fingerprint-${runId}`,
    planFingerprint: `plan-fingerprint-${runId}`,
    triggerPayload: { correlationId: `correlation-${runId}` },
    authority: "T2",
    policyVersion: "development-policy:v1",
    policyFingerprint: "development-policy-fingerprint:v1",
    nodeIds: [nodeId],
    maxRetries: 2,
  });
  const grant = await t.mutation(api.orchestrationState.markStepRunning, {
    serviceToken: SERVICE_TOKEN,
    runId,
    nodeId,
    operationId: "reasonWithTotality",
    workerId,
    leaseTtlMs: 60_000,
  });
  return { runId, nodeId, workerId, ...grant };
}

async function seedBoundClaimedSubject(t: ReturnType<typeof harness>) {
  const grant = await createActiveOrchestrationLease(t);
  await seedSubject(t, {
    state: "CLAIMED",
    fencingToken: grant.fencingToken,
    orchestrationRunId: grant.runId,
    orchestrationNodeId: grant.nodeId,
    repository: "Benny3840RG/Jarvis",
    branch: "agent/governed-dev-state-machine-phase1",
  });
  return grant;
}

async function seedAuthoritativeGitHubMerge(
  t: ReturnType<typeof harness>,
  overrides: { effectiveRisk?: number } = {},
) {
  const reviewedHeadSha = "a".repeat(40);
  const mergeCommitSha = "b".repeat(40);
  const actionId = "github-merge-action-1";
  const receiptKey = "github-merge-receipt-key-1";
  const idempotencyKey = "github-merge-operation-1";
  const policyFingerprint = "development-policy-fingerprint:v1";
  const now = Date.now();
  const authorityEnvelopeHash = computeAuthorityEnvelopeHash({
    repositories: ["Benny3840RG/Jarvis"],
    branches: ["agent/governed-dev-state-machine-phase1"],
    externalEffects: ["github.merge"],
    maxRiskClass: 3,
  });
  const toolAction: ToolAction = {
    actionId,
    requestId: "github-merge-request-1",
    projectId: "mission-1",
    baseRevision: 1,
    state: "approved",
    tool: "github",
    operation: "merge-pull-request",
    arguments: {
      subjectId: "mission-1",
      transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
      repository: "Benny3840RG/Jarvis",
      pullRequestNumber: 42,
      baseBranch: "agent/governed-dev-state-machine-phase1",
      reviewedHeadSha,
      mergeMethod: "squash",
      authorityEnvelopeHash,
      policyDecisionFingerprint: policyFingerprint,
      effectiveRisk: overrides.effectiveRisk ?? 4,
    },
    rationale: "Merge the approved and independently reviewed pull request.",
    requiredAuthority: "T3",
    destructive: true,
    idempotencyKey: "github-merge-proposal-1",
    proposedBy: "agent",
    approvedBy: "user",
    approvalExpiryPolicy: "non-expiring",
    consumptionPolicy: "single-use",
    createdAt: new Date(now - 2_000).toISOString(),
    updatedAt: new Date(now - 1_000).toISOString(),
    approvedAt: new Date(now - 1_000).toISOString(),
  };
  const actionFingerprint = fingerprintToolAction(toolAction);
  const effectFingerprint = fingerprintToolEffect(toolAction);
  await t.run(async (ctx) => {
    await ctx.db.insert("toolActions", {
      ownerId: "jarvis-cli",
      actionId,
      requestId: toolAction.requestId,
      projectKey: toolAction.projectId,
      baseRevision: toolAction.baseRevision,
      state: "approved",
      tool: toolAction.tool,
      operation: toolAction.operation,
      arguments: toolAction.arguments,
      rationale: toolAction.rationale,
      requiredAuthority: toolAction.requiredAuthority,
      destructive: toolAction.destructive,
      idempotencyKey: toolAction.idempotencyKey,
      proposedBy: toolAction.proposedBy,
      approvedBy: "user",
      approvalExpiryPolicy: "non-expiring",
      consumptionPolicy: "single-use",
      singleUseClaimedAt: now - 500,
      singleUseClaimId: idempotencyKey,
      createdAt: now - 2_000,
      updatedAt: now - 500,
      approvedAt: now - 1_000,
    });
    await ctx.db.insert("externalReconciliations", {
      ownerId: "jarvis-cli",
      reconciliationId: "github-merge-reconciliation-1",
      executionKey: "external:github-merge-operation-1",
      actionId,
      requestId: toolAction.requestId,
      projectId: toolAction.projectId,
      idempotencyKey,
      actionFingerprint,
      effectFingerprint,
      tool: "github",
      operation: "merge-pull-request",
      provider: "github-rest-v1",
      providerRequestId: `github-rest-v1:Benny3840RG/Jarvis:pull:42:sha:${reviewedHeadSha}`,
      providerCorrelationId: "github-merge-correlation-1",
      receiptKey,
      receiptId: "github-merge-receipt-1",
      state: "resolved",
      attemptCount: 0,
      nextAttemptAt: now,
      terminalStatus: "succeeded",
      resolutionDigest: "github-merge-output-digest",
      createdAt: now - 500,
      updatedAt: now,
      resolvedAt: now,
    });
    const receipt = {
      receiptId: "github-merge-receipt-1",
      actionId,
      requestId: toolAction.requestId,
      projectId: toolAction.projectId,
      idempotencyKey,
      actionFingerprint,
      effectFingerprint,
      tool: "github",
      operation: "merge-pull-request",
      actor: "agent",
      approvalId: actionId,
      policyVersion: policyFingerprint,
      correlationId: "github-merge-correlation-1",
      source: "tool-action-http-controller",
      provider: "github-rest-v1",
      providerRequestId: `github-rest-v1:Benny3840RG/Jarvis:pull:42:sha:${reviewedHeadSha}`,
      providerCorrelationId: "github-merge-correlation-1",
      reconciliationId: "github-merge-reconciliation-1",
      status: "succeeded",
      outputDigest: "github-merge-output-digest",
    } satisfies Omit<
      import("../src/actions/toolExecution.js").ToolExecutionReceipt,
      "startedAt" | "completedAt"
    >;
    await ctx.db.insert("toolExecutionReceipts", {
      ownerId: "jarvis-cli",
      receiptKey,
      ...receipt,
      startedAt: now - 500,
      completedAt: now,
      createdAt: now,
    });
  });
  return { actionId, receiptKey, reviewedHeadSha, mergeCommitSha };
}

async function auditEventsFor(t: ReturnType<typeof harness>, requestId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("auditEvents")
      .withIndex("by_owner_and_request_id", (q) =>
        q.eq("ownerId", "jarvis-cli").eq("requestId", requestId),
      )
      .take(20),
  );
}

describe("developmentState.listRecent", () => {
  it("returns this owner's subjects most-recently-updated first", async () => {
    const t = harness();
    await seedSubject(t, { subjectId: "mission-older", state: "CLAIMED" });
    await seedSubject(t, { subjectId: "mission-newer", state: "READY" });
    await t.run(async (ctx) => {
      const older = await ctx.db
        .query("developmentSubjects")
        .withIndex("by_owner_and_subject_id", (q) =>
          q.eq("ownerId", "jarvis-cli").eq("subjectId", "mission-older"),
        )
        .unique();
      if (older) await ctx.db.patch("developmentSubjects", older._id, { updatedAt: 1 });
      const newer = await ctx.db
        .query("developmentSubjects")
        .withIndex("by_owner_and_subject_id", (q) =>
          q.eq("ownerId", "jarvis-cli").eq("subjectId", "mission-newer"),
        )
        .unique();
      if (newer) await ctx.db.patch("developmentSubjects", newer._id, { updatedAt: 2 });
    });

    const subjects = await t.query(api.developmentState.listRecent, {
      serviceToken: SERVICE_TOKEN,
      limit: 10,
    });

    expect(subjects.map((subject) => subject.subjectId)).toEqual([
      "mission-newer",
      "mission-older",
    ]);
  });

  it("rejects a limit outside the bounded range", async () => {
    const t = harness();

    await expect(
      t.query(api.developmentState.listRecent, { serviceToken: SERVICE_TOKEN, limit: 0 }),
    ).rejects.toThrow(/Limit must be an integer between 1 and 100/);
    await expect(
      t.query(api.developmentState.listRecent, { serviceToken: SERVICE_TOKEN, limit: 101 }),
    ).rejects.toThrow(/Limit must be an integer between 1 and 100/);
  });
});

describe("developmentState.create", () => {
  it("creates every new subject at IDEA with an immutable existing orchestration binding", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      triggerId: "trigger-run-1",
      triggerSource: "http",
      triggerKind: "github-development-mission",
      idempotencyKey: "github:run-1",
      requestFingerprint: "request-fingerprint-run-1",
      planFingerprint: "plan-fingerprint-run-1",
      triggerPayload: { correlationId: "correlation-run-1" },
      authority: "T2",
      policyVersion: "development-policy:v1",
      policyFingerprint: "development-policy-fingerprint:v1",
      nodeIds: ["development"],
      maxRetries: 2,
    });
    const subject = await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      orchestrationRunId: "run-1",
      orchestrationNodeId: "development",
      repository: "Benny3840RG/Jarvis",
      branch: "agent/governed-dev-state-machine-phase1",
    });

    expect(subject.state).toBe("IDEA");
    expect(subject.subjectVersion).toBe(0);
    expect(subject.projectionVersion).toBe(0);
    expect(subject.orchestrationRunId).toBe("run-1");
    expect(subject.orchestrationNodeId).toBe("development");
  });

  it("is idempotent without accepting a caller-selected initial state", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      triggerId: "trigger-run-1",
      triggerSource: "http",
      triggerKind: "github-development-mission",
      idempotencyKey: "github:run-1",
      requestFingerprint: "request-fingerprint-run-1",
      planFingerprint: "plan-fingerprint-run-1",
      triggerPayload: { correlationId: "correlation-run-1" },
      authority: "T2",
      policyVersion: "development-policy:v1",
      policyFingerprint: "development-policy-fingerprint:v1",
      nodeIds: ["development"],
      maxRetries: 2,
    });
    const binding = {
      orchestrationRunId: "run-1",
      orchestrationNodeId: "development",
      repository: "Benny3840RG/Jarvis",
      branch: "agent/governed-dev-state-machine-phase1",
    };
    const first = await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      ...binding,
    });
    const second = await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      ...binding,
    });

    expect(second._id).toBe(first._id);
  });
});

describe("developmentState.listEvents", () => {
  it("fails closed instead of returning a silently truncated event history", async () => {
    const t = harness();
    await seedSubject(t);
    await t.run(async (ctx) => {
      for (let index = 0; index <= 1_000; index += 1) {
        const eventId = `event-${String(index).padStart(4, "0")}`;
        await ctx.db.insert("developmentEvents", {
          ownerId: "jarvis-cli",
          subjectId: "mission-1",
          eventId,
          requestId: eventId,
          canonicalRequestFingerprint: `request-${eventId}`,
          canonicalEventFingerprint: `event-${eventId}`,
          eventType: "DEV_MODEL_INVOCATION_RECORDED",
          eventSchemaVersion: 1,
          occurredAt: "2026-09-03T00:00:00.000Z",
          recordedAt: "2026-09-03T00:00:00.000Z",
          evidenceIds: [],
          correlationId: "correlation-1",
          reducerVersion: "DevelopmentReducer/v1",
          payload: {},
          createdAt: index,
        });
      }
    });

    await expect(
      t.query(api.developmentState.listEvents, {
        serviceToken: SERVICE_TOKEN,
        subjectId: "mission-1",
      }),
    ).rejects.toThrow("Development event history list exceeds the bounded read limit");
  });
});

describe("developmentState.commit", () => {
  it("derives the active lease and mission scope from existing durable orchestration records", async () => {
    const t = harness();
    const grant = await seedBoundClaimedSubject(t);

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        lease: {
          leaseToken: grant.leaseToken,
          leaseOwner: grant.workerId,
          leaseExpiresAt: "1900-01-01T00:00:00.000Z",
          fencingToken: grant.fencingToken,
        },
        missionAuthority: { repositories: [], branches: [], externalEffects: [], maxRiskClass: 0 },
        workerAuthority: {
          repositories: ["forged/expanded"],
          branches: ["main"],
          externalEffects: ["root"],
          maxRiskClass: 99,
        },
      }),
    );

    expect(outcome.kind).toBe("COMMITTED");
    expect(outcome.event.payload).toMatchObject({ leaseFencingToken: grant.fencingToken });
  });

  it("rejects a forged opaque lease even when its caller-supplied fencing token matches", async () => {
    const t = harness();
    const grant = await seedBoundClaimedSubject(t);

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        lease: {
          leaseToken: "forged-lease-token",
          leaseOwner: grant.workerId,
          leaseExpiresAt: "2999-09-01T01:00:00.000Z",
          fencingToken: grant.fencingToken,
        },
      }),
    );

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("ORCHESTRATION_LEASE_NOT_CURRENT");
    expect(outcome.subject.state).toBe("CLAIMED");
  });

  it("rejects a lease from a different orchestration run", async () => {
    const t = harness();
    await seedBoundClaimedSubject(t);
    const other = await createActiveOrchestrationLease(t, { runId: "run-other" });

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        lease: {
          leaseToken: other.leaseToken,
          leaseOwner: other.workerId,
          leaseExpiresAt: "2999-09-01T01:00:00.000Z",
          fencingToken: other.fencingToken,
        },
      }),
    );

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("ORCHESTRATION_LEASE_NOT_CURRENT");
  });

  it("commits a legal transition, advancing state, version, and recording the fencing token", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });

    const outcome = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());

    expect(outcome.kind).toBe("COMMITTED");
    expect(outcome.subject.state).toBe("BUILDING");
    expect(outcome.subject.subjectVersion).toBe(1);
    expect(outcome.subject.fencingToken).toBe(1);
    expect(outcome.event.eventType).toBe("DEV_TRANSITION_COMMITTED");
  });

  it("rejects an illegal transition and leaves the subject untouched, recording an audit event", async () => {
    const t = harness();
    await seedSubject(t, { state: "READY", fencingToken: 1 });

    const outcome = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("STATE_MISMATCH");
    expect(outcome.subject.state).toBe("READY");
    expect(outcome.subject.subjectVersion).toBe(0);
    expect(outcome.event.eventType).toBe("DEV_TRANSITION_REJECTED");

    const events = await t.query(api.developmentState.listEvents, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("DEV_TRANSITION_REJECTED");
    expect(await auditEventsFor(t, "request-1")).toHaveLength(1);
  });

  it("is idempotent: replaying the same event ID returns the original outcome without a second state change", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });

    const first = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());
    const second = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());

    expect(second.kind).toBe("COMMITTED");
    expect(second.subject.subjectVersion).toBe(1);
    expect(second.event._id).toBe(first.event._id);

    const events = await t.query(api.developmentState.listEvents, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
    });
    expect(events).toHaveLength(1);
  });

  it("replays the prior result when the same request is redelivered with a different event ID", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });

    const first = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());
    const redelivery = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({ eventId: "delivery-event-2" }),
    );

    expect(redelivery.kind).toBe("COMMITTED");
    expect(redelivery.event._id).toBe(first.event._id);
    expect(redelivery.subject.subjectVersion).toBe(1);
    const events = await t.query(api.developmentState.listEvents, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
    });
    expect(events).toHaveLength(1);
  });

  it("serializes two workers racing the same claim to exactly one winner (real Convex OCC)", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });

    const results = await Promise.allSettled([
      t.mutation(
        api.developmentState.commit,
        claimedToBuildingArgs({
          eventId: "event-worker-a",
          requestId: "request-worker-a",
          expectedSubjectVersion: 0,
        }),
      ),
      t.mutation(
        api.developmentState.commit,
        claimedToBuildingArgs({
          eventId: "event-worker-b",
          requestId: "request-worker-b",
          expectedSubjectVersion: 0,
        }),
      ),
    ]);

    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<
      Awaited<ReturnType<typeof t.mutation<typeof api.developmentState.commit>>>
    >[];
    const committed = fulfilled.filter((result) => result.value.kind === "COMMITTED");
    const rejected = fulfilled.filter((result) => result.value.kind === "REJECTED");

    expect(committed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Current-state validation precedes the optimistic version gate, so the
    // losing transition is rejected against the now-BUILDING subject before
    // its stale expected version is considered.
    expect(rejected[0]?.value.reasons).toContain("STATE_MISMATCH");

    const subject = await t.query(api.developmentState.get, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
    });
    expect(subject?.subjectVersion).toBe(1);
  });

  it("rejects a stale fencing token through the real mutation, distinctly from expiry", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 5 });

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        workerId: "worker-b",
        lease: {
          leaseToken: "lease-token-3",
          leaseOwner: "worker-b",
          leaseExpiresAt: "2999-09-01T01:00:00.000Z",
          fencingToken: 3,
        },
      }),
    );

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("STALE_FENCING_TOKEN");
  });

  it("rejects a higher caller-supplied fencing token instead of advancing authority", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 5 });

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        lease: {
          leaseToken: "lease-token-6",
          leaseOwner: "worker-1",
          leaseExpiresAt: "2999-09-01T01:00:00.000Z",
          fencingToken: 6,
        },
      }),
    );

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("LEASE_FENCING_TOKEN_MISMATCH");
    expect(outcome.subject.fencingToken).toBe(5);
  });

  it("fails closed when a lease-bearing transition has no issued authoritative fence", async () => {
    const t = harness();
    await seedSubject(t);

    const outcome = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("ORCHESTRATION_BINDING_REQUIRED");
    expect(outcome.subject.state).toBe("CLAIMED");
  });

  it("rejects a same event ID whose canonical command has changed and writes audit evidence", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });
    await t.mutation(api.developmentState.commit, claimedToBuildingArgs());

    const rejected = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({ correlationId: "correlation-changed" }),
    );

    expect(rejected.kind).toBe("REJECTED");
    expect(rejected.reasons).toContain("IDEMPOTENCY_EVENT_ID_CONFLICT");
    expect(rejected.subject.state).toBe("BUILDING");
    expect(await auditEventsFor(t, "request-1")).toHaveLength(1);
  });

  it("keeps repeated changed-payload request ID conflicts deterministic without duplicate event rows", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });
    const first = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());

    const firstRejected = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        eventId: "event-2",
        correlationId: "correlation-2",
        requestId: "request-1",
      }),
    );
    const secondRejected = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        eventId: "event-3",
        correlationId: "correlation-3",
        requestId: "request-1",
      }),
    );

    expect(firstRejected.kind).toBe("REJECTED");
    expect(firstRejected.reasons).toContain("IDEMPOTENCY_REQUEST_ID_CONFLICT");
    expect(secondRejected.kind).toBe("REJECTED");
    expect(secondRejected.reasons).toContain("IDEMPOTENCY_REQUEST_ID_CONFLICT");
    expect(firstRejected.event._id).toBe(first.event._id);
    expect(secondRejected.event._id).toBe(first.event._id);
    const events = await t.query(api.developmentState.listEvents, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
    });
    expect(events).toHaveLength(1);
    expect(await auditEventsFor(t, "request-1")).toHaveLength(2);
  });

  it("rejects self-causation without changing the projection", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({ causationId: "event-1" }),
    );

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("CAUSATION_SELF_REFERENCE");
    expect(outcome.subject.state).toBe("CLAIMED");
    expect(outcome.event.causationId).toBeUndefined();
    expect(validateEventEnvelope(outcome.event as unknown as JarvisEvent)).toEqual([]);
    expect(await auditEventsFor(t, "request-1")).toHaveLength(1);
  });

  it("rejects a nonexistent or future causation parent without changing the projection", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({ causationId: "future-event" }),
    );

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("CAUSATION_PARENT_NOT_FOUND");
    expect(outcome.subject.state).toBe("CLAIMED");
    expect(outcome.event.causationId).toBeUndefined();
    expect(validateEventEnvelope(outcome.event as unknown as JarvisEvent)).toEqual([]);
    expect(await auditEventsFor(t, "request-1")).toHaveLength(1);
  });

  it("rejects a causation parent belonging to a different subject", async () => {
    const t = harness();
    await seedSubject(t, { subjectId: "other-mission", fencingToken: 1 });
    await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        subjectId: "other-mission",
        eventId: "parent-event",
        requestId: "parent-request",
        correlationId: "parent-correlation",
      }),
    );
    await seedSubject(t, { fencingToken: 1 });

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({ causationId: "parent-event" }),
    );

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("CAUSATION_PARENT_NOT_FOUND");
    expect(outcome.subject.state).toBe("CLAIMED");
  });

  it("derives durable authority labels instead of accepting forged role strings", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        evaluatedBy: { actorType: "omega", actorId: "forged-omega" },
        authorisedBy: { actorType: "operator", actorId: "forged-operator" },
        committedBy: { actorType: "omega", actorId: "forged-omega" },
      }),
    );

    expect(outcome.kind).toBe("COMMITTED");
    expect(outcome.event.evaluatedBy).toEqual({
      actorType: "controller",
      actorId: "development-state-controller",
    });
    expect(outcome.event.committedBy).toEqual({
      actorType: "controller",
      actorId: "development-state-controller",
    });
    expect(outcome.event.authorisedBy).toEqual({
      actorType: "controller",
      actorId: "development-state-controller",
    });
  });

  it("rejects a caller-supplied clock instead of letting it revive an expired lease", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });

    await expect(
      // `now` is intentionally absent from the typed public API. This cast
      // simulates a raw untyped transport payload so the runtime validator is
      // also proved to reject it.
      t.mutation(api.developmentState.commit, {
        ...claimedToBuildingArgs({
          lease: {
            leaseToken: "expired-lease",
            leaseOwner: "worker-1",
            leaseExpiresAt: "2000-01-01T00:00:00.000Z",
            fencingToken: 1,
          },
        }),
        now: "1999-01-01T00:00:00.000Z",
      } as never),
    ).rejects.toThrow(/Unexpected field `now`/);
  });

  it("records event times from the trusted runtime clock", async () => {
    const t = harness();
    await seedSubject(t, { fencingToken: 1 });
    const before = Date.now();

    const outcome = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());
    const after = Date.now();

    expect(Date.parse(outcome.event.occurredAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(outcome.event.recordedAt)).toBeLessThanOrEqual(after);
  });

  it("fails closed for a crafted merge assertion without a ToolAction receipt", async () => {
    const t = harness();
    await seedSubject(t, { state: "READY_TO_MERGE", fencingToken: 1 });

    const outcome = await t.mutation(api.developmentState.commit, {
      ...claimedToBuildingArgs({
        transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
        to: "MERGED",
        approval: {
          approvalId: "approval-1",
          actorType: "operator",
          actorId: "owner",
          maxRiskClass: 3,
          subjectId: "mission-1",
          transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
          proposalHash: "proposal",
          approvedSha: "sha-1",
          effectHash: "effect",
          authorityEnvelopeHash: "authority",
          effectiveRisk: 3,
          policyDecisionFingerprint: "policy",
        },
        mergeEvidence: {
          reviewedHeadSha: "sha-1",
          currentHeadSha: "sha-1",
          reconciledMergedCommitSha: "merge-sha",
          operationOutcome: "MERGED",
        },
      }),
    });

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("MERGE_RECEIPT_REQUIRED");
    expect(outcome.subject.state).toBe("READY_TO_MERGE");
  });

  it("commits MERGED only from the exact approved ToolAction, intent, receipt, and reconciliation", async () => {
    const t = harness();
    await seedSubject(t, { state: "READY_TO_MERGE", fencingToken: 1 });
    const evidence = await seedAuthoritativeGitHubMerge(t);

    const outcome = await t.mutation(api.developmentState.commit, {
      ...claimedToBuildingArgs({
        transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
        to: "MERGED",
        mergeReceiptKey: evidence.receiptKey,
        // Caller assertions are deliberately contradictory; the mutation
        // must derive the merge evidence and approval from durable records.
        approval: undefined,
        mergeEvidence: {
          reviewedHeadSha: "c".repeat(40),
          currentHeadSha: "c".repeat(40),
          operationOutcome: "FAILED",
        },
      }),
    });

    expect(outcome.kind).toBe("COMMITTED");
    expect(outcome.subject.state).toBe("MERGED");
    expect(outcome.event.payload).toMatchObject({
      approvalId: evidence.actionId,
      mergeReceiptKey: evidence.receiptKey,
    });
  });

  it("rejects an approved merge action changed after approval", async () => {
    const t = harness();
    await seedSubject(t, { state: "READY_TO_MERGE", fencingToken: 1 });
    const evidence = await seedAuthoritativeGitHubMerge(t);
    await t.run(async (ctx) => {
      const action = await ctx.db
        .query("toolActions")
        .withIndex("by_owner_and_action_id", (q) =>
          q.eq("ownerId", "jarvis-cli").eq("actionId", evidence.actionId),
        )
        .unique();
      if (!action) throw new Error("seeded merge action missing");
      await ctx.db.patch("toolActions", action._id, {
        arguments: { ...action.arguments, reviewedHeadSha: "c".repeat(40) },
      });
    });

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
        to: "MERGED",
        mergeReceiptKey: evidence.receiptKey,
      }),
    );

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("MERGE_RECEIPT_FINGERPRINT_MISMATCH");
  });

  it("rejects merge approval after a decision-relevant orchestration policy change", async () => {
    const t = harness();
    await seedSubject(t, { state: "READY_TO_MERGE", fencingToken: 1 });
    const evidence = await seedAuthoritativeGitHubMerge(t);
    await t.run(async (ctx) => {
      const run = await ctx.db
        .query("orchestrationRuns")
        .withIndex("by_owner_and_run_id", (q) =>
          q.eq("ownerId", "jarvis-cli").eq("runId", "mission-1-run"),
        )
        .unique();
      if (!run) throw new Error("seeded run missing");
      await ctx.db.patch("orchestrationRuns", run._id, {
        policyVersion: "development-policy:v2",
        policyFingerprint: "development-policy-fingerprint:v2",
      });
    });

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
        to: "MERGED",
        mergeReceiptKey: evidence.receiptKey,
      }),
    );

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("APPROVAL_STALE_POLICY_CONTEXT");
  });

  it("never admits a merge whose action arguments carry a non-finite effectiveRisk", async () => {
    // A NaN effectiveRisk can never even reach the trusted risk-floor check
    // in practice: canonicalJson (shared by every fingerprint in this
    // boundary) already refuses to hash a non-finite number, so
    // re-fingerprinting the stored ToolAction fails closed first, before
    // the explicit `Number.isFinite` guard added to the risk check itself
    // would even run. This proves the outer guard; the inner one is
    // defense-in-depth for a path that isn't reachable without it, in case
    // the fingerprint check is ever reordered or bypassed.
    const t = harness();
    await seedSubject(t, { state: "READY_TO_MERGE", fencingToken: 1 });

    await expect(seedAuthoritativeGitHubMerge(t, { effectiveRisk: Number.NaN })).rejects.toThrow(
      /Canonical JSON rejects non-finite numbers/,
    );
  });

  it("records a direct COMPLETE attempt as a rejection -- real Omega completion must go through omegaMissions.transition", async () => {
    const t = harness();
    await seedSubject(t, { state: "MERGED" });

    const outcome = await t.mutation(api.developmentState.commit, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      eventId: "event-1",
      requestId: "request-1",
      correlationId: "correlation-1",
      transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
      to: "COMPLETE",
      requestedBy: { actorType: "controller", actorId: "mission-engine" },
      committedBy: { actorType: "omega", actorId: "omega-sigma" },
    });

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("OMEGA_COMPLETION_REQUIRES_AUTHORITY_PATH");
    expect(outcome.subject.state).toBe("MERGED");
    expect(await auditEventsFor(t, "request-1")).toHaveLength(1);
  });
});

describe("developmentState.commit -- verification/review evidence gates", () => {
  it("rejects VERIFYING -> REVIEW through the real commit boundary when no verification evidence is supplied", async () => {
    const t = harness();
    await seedSubject(t, { state: "VERIFYING" });

    const outcome = await t.mutation(api.developmentState.commit, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      eventId: "event-1",
      requestId: "request-1",
      correlationId: "correlation-1",
      transitionId: "DEV_TRANSITION_VERIFYING_TO_REVIEW",
      to: "REVIEW",
      requestedBy: { actorType: "worker", actorId: "verifier-1" },
      committedBy: { actorType: "controller", actorId: "development-controller" },
    });

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("VERIFICATION_EVIDENCE_REQUIRED");
    expect(outcome.subject.state).toBe("VERIFYING");
  });

  it("commits VERIFYING -> REVIEW through the real commit boundary once clean verification evidence is supplied", async () => {
    const t = harness();
    await seedSubject(t, { state: "VERIFYING" });

    const outcome = await t.mutation(api.developmentState.commit, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      eventId: "event-1",
      requestId: "request-1",
      correlationId: "correlation-1",
      transitionId: "DEV_TRANSITION_VERIFYING_TO_REVIEW",
      to: "REVIEW",
      requestedBy: { actorType: "worker", actorId: "verifier-1" },
      committedBy: { actorType: "controller", actorId: "development-controller" },
      verificationEvidence: {
        checksPassed: true,
        hasBlockingFindings: false,
        receiptId: "verification-receipt-1",
      },
    });

    expect(outcome.kind).toBe("COMMITTED");
    expect(outcome.subject.state).toBe("REVIEW");
    expect(outcome.event.evidenceIds).toContain("verification-receipt-1");
  });

  it("rejects REVIEW -> READY_TO_MERGE through the real commit boundary when no review evidence is supplied", async () => {
    const t = harness();
    await seedSubject(t, { state: "REVIEW" });

    const outcome = await t.mutation(api.developmentState.commit, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      eventId: "event-1",
      requestId: "request-1",
      correlationId: "correlation-1",
      transitionId: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE",
      to: "READY_TO_MERGE",
      requestedBy: { actorType: "worker", actorId: "reviewer-1" },
      committedBy: { actorType: "controller", actorId: "development-controller" },
    });

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("REVIEW_EVIDENCE_REQUIRED");
    expect(outcome.subject.state).toBe("REVIEW");
  });

  it("commits REVIEW -> READY_TO_MERGE through the real commit boundary once a clean completed review is supplied", async () => {
    const t = harness();
    await seedSubject(t, { state: "REVIEW" });

    const outcome = await t.mutation(api.developmentState.commit, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      eventId: "event-1",
      requestId: "request-1",
      correlationId: "correlation-1",
      transitionId: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE",
      to: "READY_TO_MERGE",
      requestedBy: { actorType: "worker", actorId: "reviewer-1" },
      committedBy: { actorType: "controller", actorId: "development-controller" },
      reviewEvidence: {
        reviewComplete: true,
        hasBlockingFindings: false,
        receiptId: "review-receipt-1",
      },
    });

    expect(outcome.kind).toBe("COMMITTED");
    expect(outcome.subject.state).toBe("READY_TO_MERGE");
  });
});
