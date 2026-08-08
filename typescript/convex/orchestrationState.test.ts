import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "orchestration-state-test-service-token-0000";

function harness() {
  return convexTest(schema, modules);
}

function begin(overrides: Record<string, unknown> = {}) {
  return {
    serviceToken: SERVICE_TOKEN,
    runId: "run-1",
    triggerId: "trigger-1",
    triggerSource: "scheduler" as const,
    triggerKind: "task-maintenance",
    idempotencyKey: "schedule:2026-08-08T10:00:00Z",
    requestFingerprint: "fingerprint-1",
    authority: "T1" as const,
    nodeIds: ["first", "second"],
    maxRetries: 1,
    now: 100,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Convex orchestration state", () => {
  it("atomically creates steps and replays the same trigger without duplicating the run", async () => {
    const t = harness();
    const created = await t.mutation(api.orchestrationState.beginRun, begin());
    const replayed = await t.mutation(
      api.orchestrationState.beginRun,
      begin({ runId: "different-run", now: 101 }),
    );
    const steps = await t.query(api.orchestrationState.listSteps, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
    });

    expect(created.status).toBe("created");
    expect(replayed.status).toBe("replayed");
    expect(replayed.run.runId).toBe("run-1");
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.nodeId)).toEqual(["first", "second"]);
    expect(steps.every((step) => step.state === "pending")).toBe(true);
  });

  it("returns a conflict for an idempotency key with a different fingerprint", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin());

    const conflict = await t.mutation(
      api.orchestrationState.beginRun,
      begin({ runId: "different-run", requestFingerprint: "fingerprint-2" }),
    );

    expect(conflict.status).toBe("conflict");
    expect(conflict.run.runId).toBe("run-1");
  });

  it("closes the run only after every step succeeds and records the checkpoint", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin());

    await t.mutation(api.orchestrationState.markStepRunning, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      operationId: "createTask",
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
      leaseTtlMs: 1_000,
      now: 110,
    });
    await t.mutation(api.orchestrationState.recordStepSuccess, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      outputDigest: "digest-first",
      now: 120,
    });

    expect((await t.query(api.orchestrationState.getRun, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
    }))?.state).toBe("running");

    await t.mutation(api.orchestrationState.markStepRunning, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "second",
      operationId: "completeTask",
      leaseOwner: "worker-1",
      leaseToken: "lease-2",
      leaseTtlMs: 1_000,
      now: 130,
    });
    await t.mutation(api.orchestrationState.recordStepSuccess, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "second",
      outputDigest: "digest-second",
      now: 140,
    });

    const run = await t.query(api.orchestrationState.getRun, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
    });
    expect(run?.state).toBe("succeeded");
    expect(run?.completedStepIds).toEqual(["first", "second"]);
    expect(run?.checkpointNodeId).toBe("second");
  });

  it("reopens only an expired lease and enforces a bounded restart", async () => {
    const t = harness();
    await t.mutation(
      api.orchestrationState.beginRun,
      begin({ nodeIds: ["first"], maxRetries: 1 }),
    );
    await t.mutation(api.orchestrationState.markStepRunning, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      operationId: "createTask",
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
      leaseTtlMs: 1_000,
      now: 110,
    });

    const recovered = await t.mutation(api.orchestrationState.recoverExpiredStep, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      recoveryOwner: "recovery-1",
      now: 1_110,
    });
    expect(recovered.status).toBe("recovered");
    expect(recovered.run.retryCount).toBe(1);
    expect(recovered.run.recoveryState).toBe("retrying");
    expect(recovered.step.state).toBe("pending");
    expect(recovered.run.recoveryEvidence[0]?.kind).toBe("restart");

    await t.mutation(api.orchestrationState.markStepRunning, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      operationId: "createTask",
      leaseOwner: "worker-2",
      leaseToken: "lease-2",
      leaseTtlMs: 1_000,
      now: 1_120,
    });
    const escalated = await t.mutation(api.orchestrationState.recoverExpiredStep, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      recoveryOwner: "recovery-2",
      now: 2_120,
    });
    expect(escalated.status).toBe("escalated");
    expect(escalated.run.state).toBe("failed");
    expect(escalated.step.failureCode).toBe("execution_budget_exceeded");
  });

  it("fails closed on an indeterminate provider result and forbids retry", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin({ nodeIds: ["first"] }));
    await t.mutation(api.orchestrationState.markStepRunning, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      operationId: "createTask",
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
      leaseTtlMs: 1_000,
      now: 110,
    });
    await t.mutation(api.orchestrationState.recordStepIndeterminate, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      failureCode: "dependency_failure",
      now: 120,
    });

    const run = await t.query(api.orchestrationState.getRun, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
    });
    expect(run?.state).toBe("indeterminate");
    expect(run?.recoveryState).toBe("required");
    expect(run?.recoveryEvidence[0]?.kind).toBe("indeterminate");
    await expect(
      t.mutation(api.orchestrationState.markStepRunning, {
        serviceToken: SERVICE_TOKEN,
        runId: "run-1",
        nodeId: "first",
        operationId: "createTask",
        leaseOwner: "worker-2",
        leaseToken: "lease-2",
        leaseTtlMs: 1_000,
        now: 130,
      }),
    ).rejects.toThrow(/Cannot start a step for run indeterminate/);
  });
});
