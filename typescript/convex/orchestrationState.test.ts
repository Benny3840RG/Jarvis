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
    planFingerprint: "plan-fingerprint-1",
    triggerPayload: { taskType: "maintenance" },
    authority: "T1" as const,
    policyVersion: "policy:v1",
    policyFingerprint: "policy-fingerprint-1",
    nodeIds: ["first", "second"],
    maxRetries: 1,

    ...overrides,
  };
}

async function start(
  t: ReturnType<typeof harness>,
  runId = "run-1",
  nodeId = "first",
  workerId = "worker-1",
) {
  const result = await t.mutation(api.orchestrationState.markStepRunning, {
    serviceToken: SERVICE_TOKEN,
    runId,
    nodeId,
    operationId: nodeId === "first" ? "createTask" : "completeTask",
    workerId,
    leaseTtlMs: 1_000,
  });
  return result.leaseToken;
}

async function registerReconciliation(
  t: ReturnType<typeof harness>,
  reconciliationId: string,
  runId = "run-1",
  nodeId = "first",
) {
  await t.run((ctx) =>
    ctx.db.insert("externalReconciliations", {
      ownerId: "jarvis-cli",
      reconciliationId,
      executionKey: "execution-" + reconciliationId,
      actionId: "action-" + reconciliationId,
      requestId: "request-" + reconciliationId,
      projectId: "project-1",
      idempotencyKey: "idempotency-" + reconciliationId,
      actionFingerprint: "action-" + reconciliationId,
      effectFingerprint: "effect-" + reconciliationId,
      tool: "task-tool",
      operation: nodeId === "first" ? "createTask" : "completeTask",
      provider: "task-provider",
      providerRequestId: "provider-request-" + reconciliationId,
      providerCorrelationId: "provider-correlation-" + reconciliationId,
      state: "observing",
      attemptCount: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return t.mutation(api.orchestrationState.registerReconciliation, {
    serviceToken: SERVICE_TOKEN,
    runId,
    nodeId,
    reconciliationId,
    effectFingerprint: "effect-" + reconciliationId,
    provider: "task-provider",
    providerRequestId: "provider-request-" + reconciliationId,
    providerCorrelationId: "provider-correlation-" + reconciliationId,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Convex orchestration state", () => {
  it("atomically creates steps and replays the same trigger without duplicating the run", async () => {
    const t = harness();
    const created = await t.mutation(api.orchestrationState.beginRun, begin());
    const replayed = await t.mutation(
      api.orchestrationState.beginRun,
      begin({ runId: "different-run" }),
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
    expect(steps.every((step) => !("leaseToken" in step))).toBe(true);
  });

  it("serializes concurrent idempotency requests to one durable run", async () => {
    const t = harness();
    const [first, second] = await Promise.all([
      t.mutation(api.orchestrationState.beginRun, begin({ runId: "run-a" })),
      t.mutation(api.orchestrationState.beginRun, begin({ runId: "run-b" })),
    ]);
    expect([first.status, second.status].sort()).toEqual(["created", "replayed"]);
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

    const firstLease = await start(t);
    await t.mutation(api.orchestrationState.recordStepSuccess, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      workerId: "worker-1",
      leaseToken: firstLease,
      outputDigest: "digest-first",
    });

    expect(
      (
        await t.query(api.orchestrationState.getRun, {
          serviceToken: SERVICE_TOKEN,
          runId: "run-1",
        })
      )?.state,
    ).toBe("running");

    const secondLease = await start(t, "run-1", "second");
    await t.mutation(api.orchestrationState.recordStepSuccess, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "second",
      workerId: "worker-1",
      leaseToken: secondLease,
      outputDigest: "digest-second",
    });

    const run = await t.query(api.orchestrationState.getRun, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
    });
    expect(run?.state).toBe("succeeded");
    expect(run?.completedStepIds).toEqual(["first", "second"]);
    expect(run?.checkpointNodeId).toBe("second");
  });

  it("binds leases to the worker and requires reconciliation after expiry", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin({ nodeIds: ["first"], maxRetries: 1 }));
    const grant = await t.mutation(api.orchestrationState.markStepRunning, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      operationId: "createTask",
      workerId: "worker-1",
      leaseTtlMs: 1_000,
    });
    await registerReconciliation(t, "lease-reconciliation");

    vi.advanceTimersByTime(1_000);

    await expect(
      t.mutation(api.orchestrationState.recordStepSuccess, {
        serviceToken: SERVICE_TOKEN,
        runId: "run-1",
        nodeId: "first",
        workerId: "worker-2",
        leaseToken: grant.leaseToken,
        outputDigest: "wrong-worker",
      }),
    ).rejects.toThrow(/not owned/);

    await expect(
      t.mutation(api.orchestrationState.recordStepSuccess, {
        serviceToken: SERVICE_TOKEN,
        runId: "run-1",
        nodeId: "first",
        workerId: "worker-1",
        leaseToken: grant.leaseToken,
        outputDigest: "late-success",
      }),
    ).rejects.toThrow(/lease has expired/);

    vi.advanceTimersByTime(1_000);

    const recovered = await t.mutation(api.orchestrationState.recoverExpiredStep, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      recoveryOwner: "recovery-1",
      reconciliationId: "lease-reconciliation",
    });
    vi.advanceTimersByTime(1);
    expect(recovered.status).toBe("indeterminate");
    expect(recovered.run.state).toBe("indeterminate");
    expect(recovered.step.state).toBe("indeterminate");

    await expect(
      t.mutation(api.orchestrationState.resolveIndeterminate, {
        serviceToken: SERVICE_TOKEN,
        runId: "run-1",
        nodeId: "first",
        reconciliationId: "lease-reconciliation",
      }),
    ).rejects.toThrow(/authenticated terminal/);

    await t.run((ctx) =>
      ctx.db
        .query("externalReconciliations")
        .withIndex("by_owner_and_reconciliation_id", (q) =>
          q.eq("ownerId", "jarvis-cli").eq("reconciliationId", "lease-reconciliation"),
        )
        .unique()
        .then(async (record) => {
          if (!record) throw new Error("seeded provider reconciliation missing");
          await ctx.db.patch("externalReconciliations", record._id, {
            state: "resolved",
            terminalStatus: "succeeded",
            resolutionDigest: "reconciled-digest",
            resolvedAt: Date.now(),
            updatedAt: Date.now(),
          });
        }),
    );
    const resolved = await t.mutation(api.orchestrationState.resolveIndeterminate, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      reconciliationId: "lease-reconciliation",
    });
    expect(resolved.state).toBe("succeeded");
  });

  it("fails closed on an indeterminate provider result and forbids blind retry", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin({ nodeIds: ["first"] }));
    const lease = await start(t);
    await registerReconciliation(t, "provider-reconciliation");

    await t.mutation(api.orchestrationState.recordStepIndeterminate, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      workerId: "worker-1",
      leaseToken: lease,
      indeterminateReason: "Provider did not confirm whether the effect committed.",
      reconciliationId: "provider-reconciliation",
    });

    const run = await t.query(api.orchestrationState.getRun, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
    });
    expect(run?.state).toBe("indeterminate");
    expect(run?.recoveryState).toBe("required");
    expect(run?.recoveryEvidence[0]?.kind).toBe("indeterminate");
    await expect(
      t.mutation(api.orchestrationState.retryFailedStep, {
        serviceToken: SERVICE_TOKEN,
        runId: "run-1",
        nodeId: "first",
      }),
    ).rejects.toThrow(/run indeterminate/);
  });

  it("derives retryability from the server failure classification", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin({ nodeIds: ["first"] }));
    const lease = await start(t);
    const failed = await t.mutation(api.orchestrationState.recordStepFailure, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      workerId: "worker-1",
      leaseToken: lease,
      failureCode: "audit_failure",
    });
    expect(failed.retryable).toBe(false);
    await expect(
      t.mutation(api.orchestrationState.retryFailedStep, {
        serviceToken: SERVICE_TOKEN,
        runId: "run-1",
        nodeId: "first",
      }),
    ).rejects.toThrow(/Only retryable/);
  });

  it("does not mark dependency failures retryable without a pre-effect safety classification", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin({ nodeIds: ["first"] }));
    const lease = await start(t);
    const failed = await t.mutation(api.orchestrationState.recordStepFailure, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      workerId: "worker-1",
      leaseToken: lease,
      failureCode: "dependency_failure",
    });
    expect(failed.retryable).toBe(false);
  });

  it("redacts non-allowlisted trigger payload fields before durable persistence", async () => {
    const t = harness();
    await t.mutation(
      api.orchestrationState.beginRun,
      begin({ triggerPayload: { taskType: "maintenance", metadata: "secret-value" } }),
    );
    const run = await t.query(api.orchestrationState.getRun, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
    });
    expect(run?.triggerPayload).toEqual({ taskType: "maintenance" });
  });
  it("clears retryability when a retry returns a failed step to pending", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin({ nodeIds: ["first"], maxRetries: 2 }));
    const lease = await start(t);
    await t.mutation(api.orchestrationState.recordStepFailure, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      workerId: "worker-1",
      leaseToken: lease,
      failureCode: "execution_budget_exceeded",
    });
    const retried = await t.mutation(api.orchestrationState.retryFailedStep, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
    });
    expect(retried.state).toBe("pending");
    expect(retried.retryable).toBe(false);
  });
});

