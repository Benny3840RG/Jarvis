import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

describe("jarvis-anthropic-egress-proxy entrypoint (real subprocess)", () => {
  const entrypoint = fileURLToPath(new URL("../src/acp/proxyMain.ts", import.meta.url));

  it("refuses to start with neither a socket nor a valid port", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
      env: { PATH: process.env.PATH ?? "" }, // neither SOCKET nor PORT set
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /neither .*EGRESS_SOCKET nor a valid .*EGRESS_PORT/);
  });

  it("binds to a unix socket and actually accepts a connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-proxymain-"));
    const socketPath = join(dir, "p.sock");
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
      env: { PATH: process.env.PATH ?? "", JARVIS_ACP_ANTHROPIC_EGRESS_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("proxy did not announce readiness")),
          5_000,
        );
        child.stderr.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("listening on unix:")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const { connect } = await import("node:net");
      const connected = await new Promise<boolean>((resolve) => {
        const socket = connect({ path: socketPath });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      assert.equal(connected, true);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Find a real free port (not 0 — the entrypoint requires a fixed, known port, matching real persistent-service usage). */
  async function findFreePort(): Promise<number> {
    const { createServer } = await import("node:net");
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = typeof address === "object" && address ? address.port : 0;
        probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
      });
    });
  }

  it("binds to loopback on a valid port and actually accepts a connection", async () => {
    const port = await findFreePort();
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
      env: { PATH: process.env.PATH ?? "", JARVIS_ACP_ANTHROPIC_EGRESS_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("proxy did not announce readiness")),
          5_000,
        );
        child.stderr.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("listening on")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      const { connect } = await import("node:net");
      const connected = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      assert.equal(connected, true);
    } finally {
      child.kill();
    }
  });
});
