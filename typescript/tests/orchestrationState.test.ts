import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OrchestrationContext } from "../src/orchestration/contracts.js";
import {
  InMemoryOrchestrationStateStore,
  type BeginOrchestrationRunInput,
} from "../src/orchestration/state.js";

const context: OrchestrationContext = {
  runId: "run-1",
  authority: "T1",
};

const beginInput: BeginOrchestrationRunInput = {
  runId: context.runId,
  triggerId: "trigger-1",
  triggerSource: "scheduler",
  triggerKind: "task-maintenance",
  idempotencyKey: "schedule:2026-08-08T10:00:00Z",
  requestFingerprint: "fingerprint-1",
  authority: context.authority,
  nodeIds: ["first", "second"],
  now: 100,
};

describe("InMemoryOrchestrationStateStore", () => {
  it("replays the same idempotent trigger without creating a second run", async () => {
    const store = new InMemoryOrchestrationStateStore();

    const created = await store.beginRun(beginInput);
    const replayed = await store.beginRun({
      ...beginInput,
      runId: "different-run-id",
      now: 101,
    });

    assert.equal(created.status, "created");
    assert.equal(replayed.status, "replayed");
    assert.equal(replayed.run.runId, "run-1");
    assert.deepEqual(await store.listSteps("run-1"), [
      {
        runId: "run-1",
        nodeId: "first",
        operationId: undefined,
        state: "pending",
        attempt: 0,
        updatedAt: 100,
      },
      {
        runId: "run-1",
        nodeId: "second",
        operationId: undefined,
        state: "pending",
        attempt: 0,
        updatedAt: 100,
      },
    ]);
  });

  it("returns a conflict when an idempotency key is reused for different input", async () => {
    const store = new InMemoryOrchestrationStateStore();
    await store.beginRun(beginInput);

    const result = await store.beginRun({
      ...beginInput,
      runId: "different-run-id",
      requestFingerprint: "fingerprint-2",
    });

    assert.equal(result.status, "conflict");
    assert.equal(result.run.runId, "run-1");
  });

  it("persists step completion and closes a run only after all steps complete", async () => {
    const store = new InMemoryOrchestrationStateStore();
    await store.beginRun(beginInput);

    await store.markStepRunning({
      runId: "run-1",
      nodeId: "first",
      operationId: "createTask",
      now: 110,
    });
    const first = await store.recordStepSuccess({
      runId: "run-1",
      nodeId: "first",
      now: 120,
      outputDigest: "digest-first",
    });
    assert.equal(first.state, "succeeded");
    assert.equal((await store.getRun("run-1"))?.state, "running");

    await store.markStepRunning({
      runId: "run-1",
      nodeId: "second",
      operationId: "completeTask",
      now: 130,
    });
    await store.recordStepSuccess({
      runId: "run-1",
      nodeId: "second",
      now: 140,
      outputDigest: "digest-second",
    });

    const run = await store.getRun("run-1");
    assert.equal(run?.state, "succeeded");
    assert.deepEqual(run?.completedStepIds, ["first", "second"]);
  });

  it("fails closed on an indeterminate provider outcome and will not blindly retry it", async () => {
    const store = new InMemoryOrchestrationStateStore();
    await store.beginRun(beginInput);
    await store.markStepRunning({
      runId: "run-1",
      nodeId: "first",
      operationId: "createTask",
      now: 110,
    });

    const step = await store.recordStepIndeterminate({
      runId: "run-1",
      nodeId: "first",
      now: 120,
      failureCode: "dependency_failure",
    });

    assert.equal(step.state, "indeterminate");
    assert.equal((await store.getRun("run-1"))?.state, "indeterminate");
    await assert.rejects(
      () =>
        store.markStepRunning({
          runId: "run-1",
          nodeId: "first",
          operationId: "createTask",
          now: 130,
        }),
      /cannot transition step indeterminate to running/,
    );
  });

  it("rejects invalid step transitions and duplicate node identifiers", async () => {
    assert.throws(
      () =>
        new InMemoryOrchestrationStateStore().beginRun({
          ...beginInput,
          nodeIds: ["first", "first"],
        }),
      /duplicate orchestration node ID/,
    );

    const store = new InMemoryOrchestrationStateStore();
    await store.beginRun(beginInput);
    await assert.rejects(
      () =>
        store.recordStepSuccess({
          runId: "run-1",
          nodeId: "first",
          now: 120,
        }),
      /cannot transition step pending to succeeded/,
    );
  });
});
