import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReconciliationRunResult } from "../src/reconciliation/reconciliationWorker.js";
import { ReconciliationScheduler } from "../src/reconciliation/reconciliationScheduler.js";

type WorkerLike = {
  runOnce(input: {
    workerId: string;
    leaseMs: number;
    signal: AbortSignal;
  }): Promise<ReconciliationRunResult>;
};

function resolved(id: string): ReconciliationRunResult {
  return {
    status: "resolved",
    reconciliationId: id,
    terminalStatus: "succeeded",
  };
}

describe("ReconciliationScheduler", () => {
  it("drains no more than the configured batch size in one cycle", async () => {
    const results: ReconciliationRunResult[] = [
      resolved("reconciliation-1"),
      resolved("reconciliation-2"),
      resolved("reconciliation-3"),
    ];
    let calls = 0;
    const worker: WorkerLike = {
      async runOnce() {
        calls += 1;
        return results.shift() ?? { status: "idle" };
      },
    };
    const scheduler = new ReconciliationScheduler(worker, {
      workerId: "scheduler-worker",
      leaseMs: 5_000,
      intervalMs: 1_000,
      maxBatchSize: 2,
    });

    const result = await scheduler.runCycle(new AbortController().signal);

    assert.deepEqual(result, { processed: 2, skipped: false });
    assert.equal(calls, 2);
  });

  it("skips an overlapping cycle instead of running two drains concurrently", async () => {
    let release: ((result: ReconciliationRunResult) => void) | undefined;
    let calls = 0;
    const worker: WorkerLike = {
      async runOnce() {
        calls += 1;
        return new Promise<ReconciliationRunResult>((resolve) => {
          release = resolve;
        });
      },
    };
    const scheduler = new ReconciliationScheduler(worker, {
      workerId: "scheduler-worker",
      leaseMs: 5_000,
      intervalMs: 1_000,
      maxBatchSize: 1,
    });
    const signal = new AbortController().signal;

    const first = scheduler.runCycle(signal);
    await Promise.resolve();
    const second = await scheduler.runCycle(signal);

    assert.deepEqual(second, { processed: 0, skipped: true });
    assert.equal(calls, 1);
    assert.ok(release);
    release({ status: "idle" });
    assert.deepEqual(await first, { processed: 0, skipped: false });
  });

  it("stops the scheduling loop through AbortSignal", async () => {
    const controller = new AbortController();
    let workerCalls = 0;
    let sleepCalls = 0;
    const worker: WorkerLike = {
      async runOnce() {
        workerCalls += 1;
        return { status: "idle" };
      },
    };
    const scheduler = new ReconciliationScheduler(worker, {
      workerId: "scheduler-worker",
      leaseMs: 5_000,
      intervalMs: 1_000,
      maxBatchSize: 2,
      sleep: async (_milliseconds, signal) => {
        sleepCalls += 1;
        controller.abort();
        if (!signal.aborted) throw new Error("Abort signal was not propagated to scheduler sleep.");
      },
    });

    await scheduler.run(controller.signal);

    assert.equal(workerCalls, 1);
    assert.equal(sleepCalls, 1);
  });
});
