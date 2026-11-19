import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GuardianStatusError,
  SYSTEMCTL_PATH,
  readServiceHealth,
  type CommandRunner,
} from "../src/security/guardianServiceStatus.js";
import { evaluatePrivilegedOperation } from "../src/security/privilegedOperationPolicy.js";

const OBSERVED_AT = "2026-11-19T12:00:00.000Z";

type Call = { file: string; args: readonly string[] };

function runner(output: string | Error, calls: Call[] = []): CommandRunner {
  return async (file, args) => {
    calls.push({ file, args });
    if (output instanceof Error) throw output;
    return output;
  };
}

const show = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";

async function stateFor(output: string | Error) {
  const result = await readServiceHealth("jarvis.service", {
    run: runner(output),
    now: () => OBSERVED_AT,
  });
  return result.observation.state;
}

describe("guardian service status reader", () => {
  it("runs one fixed, shell-free systemctl --user show for an allowlisted unit", async () => {
    const calls: Call[] = [];
    const result = await readServiceHealth("jarvis.service", {
      run: runner(
        show({ LoadState: "loaded", ActiveState: "active", SubState: "running", NRestarts: "0" }),
        calls,
      ),
      now: () => OBSERVED_AT,
    });
    assert.deepEqual(calls, [
      {
        file: SYSTEMCTL_PATH,
        args: [
          "--user",
          "show",
          "jarvis.service",
          "--property=LoadState,ActiveState,SubState,NRestarts",
          "--no-pager",
        ],
      },
    ]);
    assert.deepEqual(result.observation, {
      service: "jarvis.service",
      state: "healthy",
      observedAt: OBSERVED_AT,
    });
    assert.deepEqual(result.evidence, {
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      restarts: 0,
    });
  });

  it("refuses units outside the allowlist without running anything", async () => {
    for (const unit of ["sshd.service", "jarvis.service; reboot", "--all", "", 42]) {
      const calls: Call[] = [];
      await assert.rejects(
        () => readServiceHealth(unit, { run: runner("", calls), now: () => OBSERVED_AT }),
        GuardianStatusError,
      );
      assert.deepEqual(calls, []);
    }
  });

  it("reports unhealthy only for a failed unit or one stuck in auto-restart", async () => {
    assert.equal(
      await stateFor(
        show({ LoadState: "loaded", ActiveState: "failed", SubState: "failed", NRestarts: "3" }),
      ),
      "unhealthy",
    );
    assert.equal(
      await stateFor(
        show({
          LoadState: "loaded",
          ActiveState: "activating",
          SubState: "auto-restart",
          NRestarts: "1",
        }),
      ),
      "unhealthy",
    );
  });

  it("never calls a deliberately stopped or transitional unit unhealthy", async () => {
    for (const [activeState, subState] of [
      ["inactive", "dead"],
      ["deactivating", "stop-sigterm"],
      ["reloading", "reload"],
      ["activating", "start"],
      ["active", "exited"],
    ]) {
      assert.equal(
        await stateFor(
          show({
            LoadState: "loaded",
            ActiveState: activeState!,
            SubState: subState!,
            NRestarts: "0",
          }),
        ),
        "unknown",
        `${activeState}/${subState}`,
      );
    }
  });

  it("reports unknown for errors, missing units and unexpected output", async () => {
    const outputs: Array<string | Error> = [
      new Error("timed out"),
      show({ LoadState: "not-found", ActiveState: "inactive", SubState: "dead", NRestarts: "0" }),
      show({ LoadState: "loaded", ActiveState: "active" }),
      show({ LoadState: "loaded", ActiveState: "active", SubState: "running", NRestarts: "x" }),
      "LoadState=loaded\nLoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\n",
      "garbage",
      "",
      show({ LoadState: "loaded", ActiveState: "failed", SubState: "", NRestarts: "1" }),
      show({ LoadState: "", ActiveState: "failed", SubState: "failed", NRestarts: "1" }),
      show({ LoadState: "loaded", ActiveState: "FAILED", SubState: "failed", NRestarts: "1" }),
      show({ LoadState: "loaded", ActiveState: "exploded", SubState: "failed", NRestarts: "1" }),
      show({ LoadState: "loaded", ActiveState: "failed", SubState: "failed ", NRestarts: "1" }),
      show({ LoadState: "loaded", ActiveState: "failed", SubState: "dead", NRestarts: "1" }),
    ];
    for (const output of outputs) assert.equal(await stateFor(output), "unknown");
  });

  it("feeds the privilege policy, which refuses a restart on unknown health", async () => {
    const { observation } = await readServiceHealth("jarvis.service", {
      run: runner(new Error("dbus unavailable")),
      now: () => OBSERVED_AT,
    });
    const decision = evaluatePrivilegedOperation(
      { requestId: "req-1", operation: "service.restart", args: { service: "jarvis.service" } },
      {
        now: OBSERVED_AT,
        halt: "none",
        seenRequestIds: [],
        grantUses: 0,
        recentRestarts: [],
        grant: {
          grantId: "grant-1",
          operation: "service.restart",
          service: "jarvis.service",
          approvedBy: "owner",
          approvalRef: "owner-decision-fixture",
          issuedAt: "2026-11-19T11:00:00.000Z",
          expiresAt: "2026-11-20T11:00:00.000Z",
          maxUses: 3,
        },
        health: observation,
      },
    );
    assert.deepEqual(decision, { allowed: false, reason: "health_unknown" });
  });
});
