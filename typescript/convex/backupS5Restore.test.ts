import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { verifyRestoredS5TerminalOrchestration } from "../src/backup/v4/verifyS5TerminalOrchestration.js";
import { S5_TRIGGER_METADATA_KEYS } from "../src/backup/v4/s5TerminalOrchestration.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { restoreS5TerminalOrchestration } from "./backupS5Restore.js";
import { ORCHESTRATION_TRIGGER_METADATA_KEYS } from "./orchestrationState.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

type RunInsert = Omit<Doc<"orchestrationRuns">, "_id" | "_creationTime">;
type StepInsert = Omit<Doc<"orchestrationSteps">, "_id" | "_creationTime">;
type ReconciliationInsert = Omit<Doc<"orchestrationReconciliations">, "_id" | "_creationTime">;

const serviceToken = "s5-restore-service-token-000000000000000";
const approvalToken = "s5-restore-approval-token-00000000000000";
const now = 1_700_000_000_000;

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", serviceToken);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", approvalToken);
});
afterEach(() => vi.unstubAllEnvs());

function clientFor(t: ReturnType<typeof convexTest>): ConvexClientLike {
  return {
    query: t.query.bind(t) as ConvexClientLike["query"],
    mutation: () => {
      throw new Error("Verification must not mutate.");
    },
  } as ConvexClientLike;
}

async function seed(rows: (ctx: MutationCtx) => Promise<void>) {
  const source = convexTest(schema, modules);
  await source.run((ctx) => rows(ctx));
  const capture = await source.query(anyApi.backupS5.capture, { serviceToken, approvalToken });
  return capture as { payloadJson: string; payloadSha256: string };
}

function run(overrides: Partial<RunInsert> = {}): RunInsert {
  return {
    ownerId: "jarvis-cli",
    runId: "run-1",
    triggerId: "trigger-1",
    triggerSource: "cli",
    triggerKind: "manual",
    idempotencyKey: "idem-1",
    requestFingerprint: "request-fp",
    planFingerprint: "plan-fp",
    triggerPayload: { requestId: "request-1", source: "cli" },
    authority: "T1",
    policyVersion: "policy:v1",
    policyFingerprint: "policy-fp",
    nodeIds: ["step-a"],
    completedStepIds: ["step-a"],
    checkpointSequence: 1,
    state: "succeeded",
    retryCount: 0,
    maxRetries: 1,
    recoveryState: "none",
    recoveryEvidence: [],
    checkpointNodeId: "step-a",
    checkpointAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function step(overrides: Partial<StepInsert> = {}): StepInsert {
  return {
    ownerId: "jarvis-cli",
    runId: "run-1",
    nodeId: "step-a",
    operationId: "noop",
    state: "succeeded",
    attempt: 1,
    retryable: false,
    outputDigest: "digest-1",
    reconciliationId: "recon-1",
    updatedAt: now,
    completedAt: now,
    leaseFencingToken: 1,
    ...overrides,
  };
}

function reconciliation(overrides: Partial<ReconciliationInsert> = {}): ReconciliationInsert {
  return {
    ownerId: "jarvis-cli",
    reconciliationId: "recon-1",
    runId: "run-1",
    nodeId: "step-a",
    attempt: 1,
    operationId: "noop",
    effectFingerprint: "effect-1",
    provider: "demo",
    providerCorrelationId: "corr-1",
    state: "escalated",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

it("keeps the trigger metadata allowlist aligned with the producer", () => {
  expect([...S5_TRIGGER_METADATA_KEYS].sort()).toEqual(
    [...ORCHESTRATION_TRIGGER_METADATA_KEYS].sort(),
  );
});

it("restores terminal orchestration history without restarting it", async () => {
  const capture = await seed(async (ctx) => {
    const discarded = await ctx.db.insert(
      "orchestrationRuns",
      run({ runId: "discarded", idempotencyKey: "discarded" }),
    );
    await ctx.db.delete("orchestrationRuns", discarded);
    await ctx.db.insert("orchestrationRuns", run());
    await ctx.db.insert("orchestrationSteps", step());
    await ctx.db.insert("orchestrationReconciliations", reconciliation());
  });
  const target = convexTest(schema, modules);
  const identities = await target.run((ctx) =>
    restoreS5TerminalOrchestration(ctx, { ...capture, serviceToken, approvalToken }),
  );
  expect(identities.orchestrationRuns[0]?.targetId).not.toBe(
    identities.orchestrationRuns[0]?.sourceId,
  );
  const proof = await verifyRestoredS5TerminalOrchestration(
    capture,
    identities,
    clientFor(target),
    serviceToken,
    approvalToken,
  );
  expect(proof.completeness).toBe("partial");
  expect(proof.verifiedGroups).toEqual([]);
  expect(proof.restoredChecksum).toBe(proof.sourceChecksum);

  const replay = await target.mutation(anyApi.orchestrationState.beginRun, {
    serviceToken,
    runId: "run-other",
    triggerId: "trigger-1",
    triggerSource: "cli",
    triggerKind: "manual",
    idempotencyKey: "idem-1",
    requestFingerprint: "request-fp",
    planFingerprint: "plan-fp",
    triggerPayload: { requestId: "request-1", source: "cli" },
    authority: "T1",
    policyVersion: "policy:v1",
    policyFingerprint: "policy-fp",
    nodeIds: ["step-a"],
    maxRetries: 1,
  });
  expect(replay.status).toBe("replayed");
  expect(replay.run.runId).toBe("run-1");
  expect(replay.run.state).toBe("succeeded");
  await expect(
    target.mutation(anyApi.orchestrationState.markStepRunning, {
      serviceToken,
      runId: "run-1",
      nodeId: "step-a",
      operationId: "noop",
      workerId: "worker-1",
      leaseTtlMs: 1_000,
    }),
  ).rejects.toThrow(/succeeded/);
  const runs = await target.run(async (ctx) => ctx.db.query("orchestrationRuns").take(5));
  expect(runs).toHaveLength(1);
  expect(runs[0]?.state).toBe("succeeded");
});

it("refuses to retry a restored non-retryable failure", async () => {
  const capture = await seed(async (ctx) => {
    await ctx.db.insert(
      "orchestrationRuns",
      run({
        state: "failed",
        failureCode: "blocked",
        completedStepIds: [],
      }),
    );
    await ctx.db.insert(
      "orchestrationSteps",
      step({
        state: "failed",
        failureCode: "blocked",
        outputDigest: undefined,
        reconciliationId: undefined,
      }),
    );
  });
  const target = convexTest(schema, modules);
  await target.run((ctx) =>
    restoreS5TerminalOrchestration(ctx, { ...capture, serviceToken, approvalToken }),
  );
  await expect(
    target.mutation(anyApi.orchestrationState.retryFailedStep, {
      serviceToken,
      runId: "run-1",
      nodeId: "step-a",
    }),
  ).rejects.toThrow(/retryable/);
  const row = await target.query(anyApi.orchestrationState.getRun, {
    serviceToken,
    runId: "run-1",
  });
  expect(row.state).toBe("failed");
  expect(row.retryCount).toBe(0);
});

it.each([
  [
    "queued run",
    run({ state: "queued", completedStepIds: [], checkpointSequence: 0 }),
    step(),
    null,
  ],
  [
    "live lease",
    run(),
    step({ leaseOwner: "worker-1", leaseToken: "token-1", leaseExpiresAt: now + 1_000 }),
    reconciliation(),
  ],
  [
    "retryable failure",
    run({ state: "failed", failureCode: "blocked", completedStepIds: [] }),
    step({ state: "failed", failureCode: "blocked", retryable: true }),
    null,
  ],
  ["pending reconciliation", run(), step(), reconciliation({ state: "pending" })],
  [
    "unclassified trigger payload",
    run({ triggerPayload: { secretBlob: "nope" } }),
    step(),
    reconciliation(),
  ],
])("refuses %s before inserting rows", async (_label, runRow, stepRow, reconciliationRow) => {
  const capture = await seed(async (ctx) => {
    await ctx.db.insert("orchestrationRuns", runRow);
    if (stepRow) await ctx.db.insert("orchestrationSteps", stepRow);
    if (reconciliationRow) await ctx.db.insert("orchestrationReconciliations", reconciliationRow);
  });
  const target = convexTest(schema, modules);
  await expect(
    target.run((ctx) =>
      restoreS5TerminalOrchestration(ctx, { ...capture, serviceToken, approvalToken }),
    ),
  ).rejects.toThrow(/unsupported|unclassified|invalid terminal|pending|retryable|lease/i);
  const runs = await target.run(async (ctx) => ctx.db.query("orchestrationRuns").take(1));
  expect(runs).toEqual([]);
});

it("refuses a non-empty destination", async () => {
  const capture = await seed(async (ctx) => {
    await ctx.db.insert("orchestrationRuns", run());
    await ctx.db.insert("orchestrationSteps", step());
    await ctx.db.insert("orchestrationReconciliations", reconciliation());
  });
  const target = convexTest(schema, modules);
  await target.run(async (ctx) => {
    await ctx.db.insert("orchestrationRuns", run({ runId: "already", idempotencyKey: "other" }));
  });
  await expect(
    target.run((ctx) =>
      restoreS5TerminalOrchestration(ctx, { ...capture, serviceToken, approvalToken }),
    ),
  ).rejects.toThrow(/empty application database/);
});
