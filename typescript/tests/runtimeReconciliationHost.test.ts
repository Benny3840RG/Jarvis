import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createRuntimeReconciliationHost,
  resolveRuntimeReconciliationConfig,
  type EnabledReconciliationRuntime,
  type RuntimeReconciliationFactories,
} from "../src/reconciliation/runtimeReconciliationHost.js";

const enabledEnvironment = {
  JARVIS_RECONCILIATION_ENABLED: "true",
  CONVEX_URL: "https://example.convex.cloud",
  CONVEX_DEPLOYMENT: "dev:example",
  JARVIS_SERVICE_TOKEN: "service-token",
  JARVIS_RECONCILIATION_WORKER_ID: "test-worker",
} as const;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function hostWith(runtime: EnabledReconciliationRuntime) {
  return createRuntimeReconciliationHost(enabledEnvironment, {
    createEnabledRuntime() {
      return runtime;
    },
  });
}

describe("runtime reconciliation configuration", () => {
  it("is disabled by default and for an explicit false value", () => {
    assert.deepEqual(resolveRuntimeReconciliationConfig({}), {
      enabled: false,
      state: "disabled",
    });
    assert.deepEqual(
      resolveRuntimeReconciliationConfig({ JARVIS_RECONCILIATION_ENABLED: "false" }),
      { enabled: false, state: "disabled" },
    );
  });

  it("rejects ambiguous boolean spellings", () => {
    for (const value of ["TRUE", "False", "1", "yes", ""]) {
      assert.throws(
        () =>
          resolveRuntimeReconciliationConfig({
            JARVIS_RECONCILIATION_ENABLED: value,
          }),
        /JARVIS_RECONCILIATION_ENABLED must be true or false/,
      );
    }
  });

  it("requires Convex and service credentials only when enabled", () => {
    for (const missing of ["CONVEX_URL", "CONVEX_DEPLOYMENT", "JARVIS_SERVICE_TOKEN"] as const) {
      const environment: Record<string, string | undefined> = { ...enabledEnvironment };
      delete environment[missing];
      assert.throws(
        () => resolveRuntimeReconciliationConfig(environment),
        new RegExp(`${missing} is required`),
      );
    }
  });

  it("applies bounded defaults for enabled operation", () => {
    const config = resolveRuntimeReconciliationConfig(enabledEnvironment);
    assert.equal(config.enabled, true);
    if (!config.enabled) assert.fail("Expected enabled reconciliation configuration.");
    assert.equal(config.leaseMs, 30_000);
    assert.equal(config.intervalMs, 5_000);
    assert.equal(config.maxBatchSize, 10);
    assert.equal(config.maxAttempts, 5);
    assert.equal(config.baseRetryMs, 1_000);
    assert.equal(config.maxRetryMs, 60_000);
    assert.equal(config.workerId, "test-worker");
  });

  it("rejects unsafe integers, out-of-range bounds, and reversed retry delays", () => {
    const invalidCases: Array<[string, string, RegExp]> = [
      ["JARVIS_RECONCILIATION_LEASE_MS", "0", /positive safe integer/],
      ["JARVIS_RECONCILIATION_INTERVAL_MS", "1.5", /positive safe integer/],
      ["JARVIS_RECONCILIATION_BATCH_SIZE", "101", /between 1 and 100/],
      ["JARVIS_RECONCILIATION_MAX_ATTEMPTS", "0", /positive safe integer/],
      ["JARVIS_RECONCILIATION_BASE_RETRY_MS", "9007199254740992", /positive safe integer/],
    ];

    for (const [name, value, expected] of invalidCases) {
      assert.throws(
        () => resolveRuntimeReconciliationConfig({ ...enabledEnvironment, [name]: value }),
        expected,
      );
    }

    assert.throws(
      () =>
        resolveRuntimeReconciliationConfig({
          ...enabledEnvironment,
          JARVIS_RECONCILIATION_BASE_RETRY_MS: "2000",
          JARVIS_RECONCILIATION_MAX_RETRY_MS: "1000",
        }),
      /MAX_RETRY_MS must be greater than or equal to BASE_RETRY_MS/,
    );
  });

  it("fails closed when enabled without a provider adapter", () => {
    assert.throws(
      () => createRuntimeReconciliationHost(enabledEnvironment),
      /at least one provider reconciliation adapter is required/i,
    );
  });

  it("does not construct reconciliation dependencies while disabled", () => {
    let constructions = 0;
    const host = createRuntimeReconciliationHost(
      {},
      {
        createEnabledRuntime() {
          constructions += 1;
          throw new Error("Disabled mode must not construct an enabled runtime.");
        },
      },
    );

    assert.equal(constructions, 0);
    assert.deepEqual(host.health(), {
      state: "disabled",
      enabled: false,
    });
  });
});

describe("runtime reconciliation lifecycle", () => {
  it("records cycle timing and processed count from scheduler observations", async () => {
    let observeCycle:
      Parameters<RuntimeReconciliationFactories["createEnabledRuntime"]>[1] | undefined;
    const host = createRuntimeReconciliationHost(enabledEnvironment, {
      createEnabledRuntime(_config, observer) {
        observeCycle = observer;
        return {
          async run(signal) {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          },
        };
      },
    });

    await host.start();
    assert.ok(observeCycle);
    observeCycle({ type: "started" });
    const afterStart = host.health();
    assert.match(afterStart.lastCycleStartedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(afterStart.lastCycleCompletedAt, undefined);

    observeCycle({ type: "completed", processed: 3, failureCount: 0 });
    const afterCompletion = host.health();
    assert.match(afterCompletion.lastCycleCompletedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(afterCompletion.lastCycleProcessed, 3);
    assert.equal(afterCompletion.lastCycleOutcome, "success");
    assert.equal(afterCompletion.lastCycleFailureCount, 0);
    assert.equal(afterCompletion.consecutiveFailureCount, 0);
    assert.match(afterCompletion.lastSuccessfulCycleAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    await host.stop();
  });

  it("recovers health after a later successful cycle", async () => {
    let observeCycle:
      Parameters<RuntimeReconciliationFactories["createEnabledRuntime"]>[1] | undefined;
    const host = createRuntimeReconciliationHost(enabledEnvironment, {
      createEnabledRuntime(_config, observer) {
        observeCycle = observer;
        return {
          async run(signal) {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          },
        };
      },
    });

    await host.start();
    assert.ok(observeCycle);
    observeCycle({ type: "started" });
    observeCycle({ type: "completed", processed: 1, failureCount: 1 });
    assert.equal(host.health().lastCycleOutcome, "degraded");
    assert.equal(host.health().consecutiveFailureCount, 1);

    observeCycle({ type: "started" });
    observeCycle({ type: "completed", processed: 1, failureCount: 0 });
    assert.equal(host.health().lastCycleOutcome, "success");
    assert.equal(host.health().consecutiveFailureCount, 0);
    assert.equal(host.health().lastErrorCode, undefined);
    await host.stop();
  });

  it("starts exactly one loop when start is repeated", async () => {
    const release = deferred();
    let runs = 0;
    const host = hostWith({
      async run(signal) {
        runs += 1;
        await release.promise;
        assert.equal(signal.aborted, true);
      },
    });

    await Promise.all([host.start(), host.start(), host.start()]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(runs, 1);
    assert.equal(host.health().state, "running");

    const stopping = host.stop();
    release.resolve();
    await stopping;
    assert.equal(host.health().state, "stopped");
  });

  it("aborts sleeping work and waits for the loop to finish", async () => {
    const entered = deferred();
    const exited = deferred();
    const host = hostWith({
      async run(signal) {
        entered.resolve();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        exited.resolve();
      },
    });

    await host.start();
    await entered.promise;
    const stopping = host.stop();
    assert.equal(host.health().state, "stopping");
    await exited.promise;
    await stopping;
    assert.equal(host.health().state, "stopped");
  });

  it("waits for active reconciliation after cancellation", async () => {
    const active = deferred();
    const complete = deferred();
    let stopSettled = false;
    const host = hostWith({
      async run(signal) {
        active.resolve();
        await complete.promise;
        assert.equal(signal.aborted, true);
      },
    });

    await host.start();
    await active.promise;
    const stopping = host.stop().then(() => {
      stopSettled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(stopSettled, false);
    complete.resolve();
    await stopping;
    assert.equal(stopSettled, true);
  });

  it("reports loop failure using only a stable redacted error code", async () => {
    const host = hostWith({
      async run() {
        throw new Error("service-token secret provider/reference");
      },
    });

    await host.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(host.health(), {
      state: "degraded",
      enabled: true,
      freshnessMs: 60_000,
      workerId: "test-worker",
      startedAt: host.health().startedAt,
      consecutiveFailureCount: 0,
      lastErrorCode: "reconciliation-loop-failed",
    });
    assert.doesNotMatch(JSON.stringify(host.health()), /service-token|provider\/reference|secret/);
    await host.stop();
    assert.equal(host.health().state, "degraded");
  });

  it("allows stop to be repeated without changing the result", async () => {
    const host = hostWith({
      async run(signal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      },
    });

    await host.start();
    await Promise.all([host.stop(), host.stop(), host.stop()]);
    assert.equal(host.health().state, "stopped");
  });
});
