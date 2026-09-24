import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CircuitOpenError,
  ProbeTimeoutError,
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

  it("times out a slow probe instead of blocking future attempts forever", async () => {
    let now = 1_000;
    const controller = new ReliabilityController({
      clock: () => now,
      failureThreshold: 1,
      cooldownMs: 50,
      probeTimeoutMs: 10,
    });

    const slowProbe = () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 40));

    await assert.rejects(controller.run("persistence", slowProbe), ProbeTimeoutError);

    const afterTimeout = controller.snapshot("persistence");
    assert.equal(afterTimeout.state, "open");
    assert.equal(afterTimeout.lastFailureCode, "probe-timeout");

    // Without a timeout, halfOpenProbeInFlight would stay true forever and this
    // second attempt (after cooldown) would be silently blocked instead of
    // actually invoking the probe.
    now += 50;
    assert.equal(await controller.run("persistence", async () => "recovered"), "recovered");
    assert.equal(controller.snapshot("persistence").state, "closed");
  });

  it("ignores a slow probe's late settlement after it has already timed out", async () => {
    const controller = new ReliabilityController({
      clock: () => 2_000,
      failureThreshold: 1,
      probeTimeoutMs: 10,
    });

    // Resolves naturally, well after the 10ms probe timeout has already fired.
    const slowProbe = () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 40));

    await assert.rejects(controller.run("persistence", slowProbe), ProbeTimeoutError);
    assert.equal(controller.snapshot("persistence").state, "open");

    // Wait past the slow probe's own natural resolution. It must not
    // retroactively flip the breaker back to closed once it does settle.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(controller.snapshot("persistence").state, "open");
  });

  it("rejects a probeTimeoutMs beyond Node's max timer delay", () => {
    // Above this, Node clamps setTimeout to fire almost immediately instead of
    // actually waiting — a silent, surprising near-instant timeout.
    assert.throws(
      () => new ReliabilityController({ probeTimeoutMs: 2_147_483_648 }),
      /no greater than 2147483647/,
    );
  });
});
