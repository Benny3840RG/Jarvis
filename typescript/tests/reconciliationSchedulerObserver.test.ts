import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ReconciliationScheduler,
  type ReconciliationCycleObservation,
} from "../src/reconciliation/reconciliationScheduler.js";

function options(observeCycle: (observation: ReconciliationCycleObservation) => void) {
  return {
    workerId: "observer-worker",
    leaseMs: 5_000,
    intervalMs: 1_000,
    maxBatchSize: 2,
    observeCycle,
  };
}

describe("ReconciliationScheduler cycle observation", () => {
  it("reports a successful cycle and its bounded processed count", async () => {
    const observations: ReconciliationCycleObservation[] = [];
    const results = [
      {
        status: "resolved" as const,
        reconciliationId: "one",
        terminalStatus: "succeeded" as const,
      },
      { status: "idle" as const },
    ];
    const scheduler = new ReconciliationScheduler(
      {
        async runOnce() {
          return results.shift() ?? { status: "idle" };
        },
      },
      options((observation) => observations.push(observation)),
    );

    assert.deepEqual(await scheduler.runCycle(new AbortController().signal), {
      processed: 1,
      skipped: false,
    });
    assert.deepEqual(observations, [{ type: "started" }, { type: "completed", processed: 1 }]);
  });

  it("reports an overlapping cycle as skipped without another start", async () => {
    let release!: () => void;
    const observations: ReconciliationCycleObservation[] = [];
    const scheduler = new ReconciliationScheduler(
      {
        async runOnce() {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { status: "idle" };
        },
      },
      options((observation) => observations.push(observation)),
    );
    const signal = new AbortController().signal;

    const first = scheduler.runCycle(signal);
    await Promise.resolve();
    assert.deepEqual(await scheduler.runCycle(signal), { processed: 0, skipped: true });
    assert.deepEqual(observations, [{ type: "started" }, { type: "skipped" }]);
    release();
    await first;
  });

  it("reports failure and rethrows the worker error", async () => {
    const observations: ReconciliationCycleObservation[] = [];
    const scheduler = new ReconciliationScheduler(
      {
        async runOnce() {
          throw new Error("claim failed");
        },
      },
      options((observation) => observations.push(observation)),
    );

    await assert.rejects(scheduler.runCycle(new AbortController().signal), /claim failed/);
    assert.deepEqual(observations, [{ type: "started" }, { type: "failed" }]);
  });

  it("does not let observer failure alter the cycle result", async () => {
    const scheduler = new ReconciliationScheduler(
      {
        async runOnce() {
          return { status: "idle" };
        },
      },
      options(() => {
        throw new Error("telemetry failed");
      }),
    );

    assert.deepEqual(await scheduler.runCycle(new AbortController().signal), {
      processed: 0,
      skipped: false,
    });
  });
});
