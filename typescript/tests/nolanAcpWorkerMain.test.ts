import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Real-subprocess proof of the entrypoint's fail-closed startup path. Only
 * the "no credential configured" path is exercised here — it needs no
 * network and no real key, matching the offline/Gate-B tier. A real Anthropic
 * call is deliberately out of scope for this suite.
 */
describe("nolan-acp-worker entrypoint (real subprocess)", () => {
  const entrypoint = fileURLToPath(new URL("../src/acp/main.ts", import.meta.url));

  it("refuses to start when no Anthropic credential is configured: exits non-zero, writes nothing to stdout", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
      env: { PATH: process.env.PATH ?? "" }, // deliberately no CREDENTIALS_DIRECTORY / key
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    assert.notEqual(exitCode, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /no Anthropic credential configured/);
  });
});
