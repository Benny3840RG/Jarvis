import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import { waitForWorkerReady } from "./helpers/processHarness.js";

describe("Temporal PASS worker readiness framing", () => {
  it("detects WORKER_READY when stdout splits the marker across chunks", async () => {
    const proc = spawn(
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write('WORKER_');",
          "setTimeout(() => process.stdout.write('READY\\n'), 20);",
          "setTimeout(() => process.exit(0), 100);",
        ].join(""),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.ok(proc.stdout);
    assert.ok(proc.stderr);
    await waitForWorkerReady(
      proc as typeof proc & { stdout: NonNullable<typeof proc.stdout>; stderr: NonNullable<typeof proc.stderr> },
      2_000,
    );
    proc.kill("SIGKILL");
  });
});
