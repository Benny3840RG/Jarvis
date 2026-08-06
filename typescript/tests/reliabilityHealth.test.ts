import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessReconciliationHealth } from "../src/reliability/reliabilityHealth.js";
import type { RuntimeReconciliationHealth } from "../src/reconciliation/runtimeReconciliationHost.js";

const NOW = 10_000;

function enabledHealth(
  overrides: Partial<RuntimeReconciliationHealth> = {},
): RuntimeReconciliationHealth {
  return {
    state: "running",
    enabled: true,
    workerId: "worker-1",
    freshnessMs: 500,
    ...overrides,
  };
}

describe("reconciliation reliability health", () => {
  it("does not require reconciliation evidence when the worker is disabled", () => {
    assert.deepEqual(assessReconciliationHealth({ state: "disabled", enabled: false }, NOW), {
      healthy: true,
    });
  });

  it("blocks readiness until a successful fresh cycle exists", () => {
    assert.deepEqual(assessReconciliationHealth(enabledHealth(), NOW), {
      healthy: false,
      reason: "reconciliation-no-successful-cycle",
    });
    assert.deepEqual(
      assessReconciliationHealth(
        enabledHealth({
          lastCycleOutcome: "success",
          lastSuccessfulCycleAt: new Date(NOW - 100).toISOString(),
          lastCycleFailureCount: 0,
        }),
        NOW,
      ),
      { healthy: true },
    );
  });

  it("rejects degraded states, failed cycles, and stale successful cycles", () => {
    const notRunning = assessReconciliationHealth(enabledHealth({ state: "degraded" }), NOW);
    assert.equal(notRunning.healthy, false);
    if (notRunning.healthy) assert.fail("degraded reconciliation must not be healthy");
    assert.equal(notRunning.reason, "reconciliation-not-running");

    const failed = assessReconciliationHealth(
      enabledHealth({
        lastCycleOutcome: "degraded",
        lastCycleFailureCount: 1,
        lastSuccessfulCycleAt: new Date(NOW - 100).toISOString(),
      }),
      NOW,
    );
    assert.equal(failed.healthy, false);
    if (failed.healthy) assert.fail("failed reconciliation must not be healthy");
    assert.equal(failed.reason, "reconciliation-cycle-failed");

    const stale = assessReconciliationHealth(
      enabledHealth({
        lastCycleOutcome: "success",
        lastCycleFailureCount: 0,
        lastSuccessfulCycleAt: new Date(NOW - 501).toISOString(),
      }),
      NOW,
    );
    assert.equal(stale.healthy, false);
    if (stale.healthy) assert.fail("stale reconciliation must not be healthy");
    assert.equal(stale.reason, "reconciliation-cycle-stale");
  });
});
