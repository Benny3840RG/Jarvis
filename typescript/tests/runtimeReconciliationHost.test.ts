import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createRuntimeReconciliationHost,
  resolveRuntimeReconciliationConfig,
} from "../src/reconciliation/runtimeReconciliationHost.js";

const enabledEnvironment = {
  JARVIS_RECONCILIATION_ENABLED: "true",
  CONVEX_URL: "https://example.convex.cloud",
  CONVEX_DEPLOYMENT: "dev:example",
  JARVIS_SERVICE_TOKEN: "service-token",
} as const;

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
    assert.deepEqual(resolveRuntimeReconciliationConfig({}), {
      enabled: false,
      state: "disabled",
    });

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
    assert.match(config.workerId, /^[A-Za-z0-9._:-]+$/);
  });

  it("rejects unsafe integers, out-of-range bounds, and reversed retry delays", () => {
    const invalidCases: Array<[string, string, RegExp]> = [
      ["JARVIS_RECONCILIATION_LEASE_MS", "0", /positive safe integer/],
      ["JARVIS_RECONCILIATION_INTERVAL_MS", "1.5", /positive safe integer/],
      ["JARVIS_RECONCILIATION_BATCH_SIZE", "101", /between 1 and 100/],
      ["JARVIS_RECONCILIATION_MAX_ATTEMPTS", "0", /between 1 and 100/],
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
