import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Connection } from "@temporalio/client";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const typescriptRoot = path.resolve(dirname, "../../..");
const runWorkerProcessPath = path.resolve(
  typescriptRoot,
  "src/preview/temporalPass/temporal/runWorkerProcess.ts",
);

const TEMPORAL_CLI = process.env.TEMPORAL_CLI_PATH ?? "temporal";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Failed to acquire a free port"));
      }
    });
  });
}

/**
 * Poll until the Temporal dev server accepts a client connection. The deadline
 * is generous (60s) because `temporal server start-dev` boot time on a loaded
 * CI runner varies widely; a tight 20s deadline was a flake source. If the
 * server process exits before it is ready, fail immediately with its exit code
 * rather than spinning uselessly until the deadline.
 */
async function waitForServerReady(
  address: string,
  serverProcess: ChildProcess,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      throw new Error(
        `Temporal dev server at ${address} exited before becoming ready (code ${serverProcess.exitCode}, signal ${serverProcess.signalCode}).`,
      );
    }
    try {
      const connection = await Connection.connect({ address });
      await connection.close();
      return;
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw new Error(
    `Temporal dev server at ${address} did not become ready within ${timeoutMs}ms: ${String(lastError)}`,
  );
}

function pipeWithPrefix(
  proc: ChildProcess & { stdout: Readable; stderr: Readable },
  prefix: string,
): void {
  proc.stdout.on("data", (chunk: Buffer) => process.stdout.write(`[${prefix}] ${chunk}`));
  proc.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[${prefix}] ${chunk}`));
}

export function waitForWorkerReady(
  proc: ChildProcess & { stdout: Readable; stderr: Readable },
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const marker = "WORKER_READY";
    let stdoutTail = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Worker process did not report WORKER_READY in time"));
    }, timeoutMs);
    function onData(chunk: Buffer): void {
      // Stream chunks are arbitrary boundaries. Retain a bounded tail so a
      // marker split across two writes (for example "WORKER_" + "READY")
      // is still detected without accumulating unbounded worker output.
      stdoutTail = (stdoutTail + chunk.toString("utf8")).slice(-marker.length * 2);
      if (stdoutTail.includes(marker)) {
        cleanup();
        resolve();
      }
    }
    function onExit(code: number | null): void {
      cleanup();
      reject(new Error(`Worker process exited before becoming ready (code ${code})`));
    }
    function cleanup(): void {
      clearTimeout(timer);
      proc.stdout.off("data", onData);
      proc.off("exit", onExit);
    }
    proc.stdout.on("data", onData);
    proc.once("exit", onExit);
  });
}

/**
 * Tier 2 harness: a real `temporal server start-dev` process and a real
 * worker process (`runWorkerProcess.ts`), each independently killable and
 * restartable, sharing an on-disk SQLite file (`--db-filename`) and the
 * idempotency/mock-repo JSON files — so a "reboot" genuinely means "both
 * processes die and come back," not an in-process simulation.
 */
export class ProcessHarness {
  readonly taskQueue: string;
  readonly dbFilename: string;
  readonly idempotencyPath: string;
  readonly mockRepoPath: string;

  address = "";
  private serverProcess: (ChildProcess & { stdout: Readable; stderr: Readable }) | undefined;
  private workerProcess: (ChildProcess & { stdout: Readable; stderr: Readable }) | undefined;

  constructor() {
    const runId = randomUUID();
    this.taskQueue = `temporal-pass-tier2-${runId}`;
    this.dbFilename = path.join(os.tmpdir(), `temporal-pass-tier2-${runId}.sqlite`);
    this.idempotencyPath = path.join(os.tmpdir(), `temporal-pass-tier2-idempotency-${runId}.json`);
    this.mockRepoPath = path.join(os.tmpdir(), `temporal-pass-tier2-mock-repo-${runId}.json`);
  }

  async startServer(): Promise<void> {
    const port = await getFreePort();
    this.address = `127.0.0.1:${port}`;
    const proc = spawn(
      TEMPORAL_CLI,
      [
        "server",
        "start-dev",
        "--port",
        String(port),
        "--db-filename",
        this.dbFilename,
        "--headless",
        "--log-format",
        "pretty",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    pipeWithPrefix(proc, "temporal-server");
    this.serverProcess = proc;
    await waitForServerReady(this.address, proc);
  }

  killServer(): void {
    this.serverProcess?.kill("SIGKILL");
    this.serverProcess = undefined;
  }

  async startWorker(): Promise<void> {
    if (!this.address) throw new Error("startServer() must be called before startWorker()");
    const proc = spawn(process.execPath, ["--import", "tsx", runWorkerProcessPath], {
      env: {
        ...process.env,
        TEMPORAL_ADDRESS: this.address,
        TEMPORAL_TASK_QUEUE: this.taskQueue,
        TEMPORAL_PASS_IDEMPOTENCY_PATH: this.idempotencyPath,
        TEMPORAL_PASS_MOCK_REPO_PATH: this.mockRepoPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    pipeWithPrefix(proc, "temporal-worker");
    this.workerProcess = proc;
    await waitForWorkerReady(proc);
  }

  killWorker(): void {
    this.workerProcess?.kill("SIGKILL");
    this.workerProcess = undefined;
  }

  async teardown(): Promise<void> {
    this.killWorker();
    this.killServer();
    await sleep(100);
  }
}
