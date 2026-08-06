import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CircuitOpenError,
  ReliabilityController,
} from "../src/reliability/reliabilityController.js";

describe("ReliabilityController", () => {
  it("opens after repeated probe failures and blocks until the cooldown expires", async () => {
    let now = 1_000;
    const controller = new ReliabilityController({
      clock: () => now,
      failureThreshold: 2,
      cooldownMs: 100,
    });

    await assert.rejects(
      controller.run("persistence", async () => {
        throw new Error("provider secret must not escape");
      }),
    );
    await assert.rejects(
      controller.run("persistence", async () => {
        throw new Error("provider secret must not escape");
      }),
    );

    assert.equal(controller.snapshot("persistence").state, "open");
    await assert.rejects(
      controller.run("persistence", async () => "blocked"),
      CircuitOpenError,
    );

    now += 100;
    assert.equal(await controller.run("persistence", async () => "recovered"), "recovered");
    assert.deepEqual(controller.snapshot("persistence"), {
      state: "closed",
      consecutiveFailures: 0,
      totalFailures: 2,
      totalSuccesses: 1,
      lastFailureCode: "probe-failed",
      lastCheckedAt: 1_100,
    });
  });

  it("reports partial evidence without exposing probe errors", async () => {
    const controller = new ReliabilityController({ clock: () => 5_000 });

    assert.deepEqual(controller.layerStatus(), {
      status: "inactive",
      reason: "No reliability probe evidence has been collected.",
    });

    await controller.run("persistence", async () => undefined);

    assert.deepEqual(controller.layerStatus(), {
      status: "partial",
      reason:
        "Persistence probe passed; recovery and external dependency probes remain uncommissioned.",
    });

    const failed = new ReliabilityController({ clock: () => 6_000 });
    await assert.rejects(
      failed.run("persistence", async () => {
        throw new Error("current-secret");
      }),
    );
    assert.deepEqual(failed.layerStatus(), {
      status: "partial",
      reason: "Persistence probe failed; the failure is recorded without raw provider details.",
    });
    assert.doesNotMatch(JSON.stringify(failed.snapshot("persistence")), /current-secret/);
  });
});
