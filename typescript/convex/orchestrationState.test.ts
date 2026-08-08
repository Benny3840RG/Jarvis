npm warn Unknown env config "http-proxy". This will stop working in the next major version of npm.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "orchestration-state-test-service-token-0000";
const now = () => Date.now();

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
    now: now(),
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
    now: now(),
  });
  return result.leaseToken;
}

async function registerReconciliation(
  t: ReturnType<typeof harness>,
  reconciliationId: string,
  runId = "run-1",
  nodeId = "first",
  attempt = 1,
) {
  return t.mutation(api.orchestrationState.registerReconciliation, {
    serviceToken: SERVICE_TOKEN,
    runId,
    nodeId,
    reconciliationId,
    effectFingerprint: "effect-" + reconciliationId,
    provider: "task-provider",
    providerRequestId: "provider-request-" + reconciliationId,
    providerCorrelationId: "provider-correlation-" + reconciliationId,
    now: now(),
  });
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
      begin({ runId: "different-run", now: now() }),
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
      now: now(),
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
      now: now(),
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
    const leaseStart = now();
    const grant = await t.mutation(api.orchestrationState.markStepRunning, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      operationId: "createTask",
      workerId: "worker-1",
      leaseTtlMs: 1_000,
      now: leaseStart,
    });
    await registerReconciliation(t, "lease-reconciliation");

    await expect(
      t.mutation(api.orchestrationState.recordStepSuccess, {
        serviceToken: SERVICE_TOKEN,
        runId: "run-1",
        nodeId: "first",
        workerId: "worker-2",
        leaseToken: grant.leaseToken,
        outputDigest: "wrong-worker",
        now: leaseStart + 100,
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
        now: leaseStart + 1_000,
      }),
    ).rejects.toThrow(/lease has expired/);

    const recovered = await t.mutation(api.orchestrationState.recoverExpiredStep, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      recoveryOwner: "recovery-1",
      reconciliationId: "lease-reconciliation",
      now: leaseStart + 1_001,
    });
    expect(recovered.status).toBe("indeterminate");
    expect(recovered.run.state).toBe("indeterminate");
    expect(recovered.step.state).toBe("indeterminate");

    await expect(
      t.mutation(api.orchestrationState.resolveIndeterminate, {
        serviceToken: SERVICE_TOKEN,
        runId: "run-1",
        nodeId: "first",
        reconciliationId: "lease-reconciliation",
        now: leaseStart + 1_002,
      }),
    ).rejects.toThrow(/no verified terminal/);

    await t.mutation(api.orchestrationState.recordReconciliationOutcome, {
      serviceToken: SERVICE_TOKEN,
      reconciliationId: "lease-reconciliation",
      outcome: "succeeded",
      outputDigest: "reconciled-digest",
      evidenceDetail: "Provider lookup returned the committed task.",
      resolverId: "recovery-1",
      now: leaseStart + 1_003,
    });
    const resolved = await t.mutation(api.orchestrationState.resolveIndeterminate, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-1",
      nodeId: "first",
      reconciliationId: "lease-reconciliation",
      now: leaseStart + 1_004,
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
      now: now(),
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
        now: now(),
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
      now: now(),
    });
    expect(failed.retryable).toBe(false);
    await expect(
      t.mutation(api.orchestrationState.retryFailedStep, {
        serviceToken: SERVICE_TOKEN,
        runId: "run-1",
        nodeId: "first",
        now: now(),
      }),
    ).rejects.toThrow(/Only retryable/);
  });
});
npm notice
npm notice New minor version of npm available! 11.9.0 -> 11.19.0
npm notice Changelog: https://github.com/npm/cli/releases/tag/v11.19.0
npm notice To update run: npm install -g npm@11.19.0
npm notice
