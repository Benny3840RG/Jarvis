import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { localV1LiveDirectoryDigest } from "./localV1Proof.js";

/**
 * Loopback URL that is not a Convex deployment. The existing HTTP entrypoint
 * constructs a notes client from `CONVEX_URL` at startup. The restarted process
 * is given this value so that client is not the configured deployment URL.
 * Quote GETs are not served by it.
 */
export const LOCAL_V1_RESTART_CONVEX_SENTINEL = "http://127.0.0.1:9";

const SERVICE_TOKEN = "local-v1-restart-service-token-000000";
const LISTEN_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

const typescriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type RestartedProcessBody = {
  clientBody: string;
  taskBody: string;
  buildBody: string;
  quoteStatus: number;
  quoteBody: string;
};

export type RestartedProcessResult = {
  first: RestartedProcessBody;
  second: RestartedProcessBody;
  /**
   * True only when both processes GET the same quote from an isolated Convex
   * URL. The default JSON harness leaves this false.
   */
  quoteRecovered: boolean;
};

export type RestartedProcessRequest = {
  jsonDirectory: string;
  liveDirectory: string;
  clientId: string;
  taskId: string;
  buildId: string;
  quoteId: string;
  /** The deployment URL this proof must not hand to the child. */
  configuredConvexUrl: string | undefined;
  /**
   * Isolated Convex backend. Absent keeps the JSON-only harness. Refused when
   * it is the configured CONVEX_URL or any `*.convex.cloud` host.
   */
  isolatedConvexUrl?: string;
  /** Defaults to the harness token. A host backend can supply its own. */
  serviceToken?: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Local V1 process restart could not reserve a port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function childEnvironment(
  request: RestartedProcessRequest,
  port: number,
  serviceToken: string,
): NodeJS.ProcessEnv {
  const isolated = request.isolatedConvexUrl;
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    PERSISTENCE_PROVIDER: isolated === undefined ? "json" : "convex",
    JARVIS_DATA_DIR: path.resolve(request.jsonDirectory),
    JARVIS_SERVICE_TOKEN: serviceToken,
    JARVIS_HTTP_HOST: "127.0.0.1",
    JARVIS_HTTP_PORT: String(port),
    JARVIS_SOURCE_VERSION: "local-v1-proof",
    JARVIS_TIMEZONE: "Australia/Melbourne",
    JARVIS_OUTLOOK_ENABLED: "false",
    JARVIS_RECONCILIATION_ENABLED: "false",
    JARVIS_POSTHOG_ENABLED: "false",
    CONVEX_URL: isolated ?? LOCAL_V1_RESTART_CONVEX_SENTINEL,
  };
}

function assertIsolatedConvexUrl(url: string, configured: string | undefined): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Local V1 process restart isolated Convex URL is not an isolated http(s) URL.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error("Local V1 process restart isolated Convex URL is not an isolated http(s) URL.");
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "convex.cloud" || host.endsWith(".convex.cloud")) {
    throw new Error("Local V1 process restart refuses a Convex cloud URL.");
  }
  const configuredTrimmed = configured?.trim();
  if (configuredTrimmed === undefined || configuredTrimmed.length === 0) return;
  if (url.trim() === configuredTrimmed) {
    throw new Error("Local V1 process restart refuses the configured CONVEX_URL.");
  }
  try {
    if (parsed.href === new URL(configuredTrimmed).href) {
      throw new Error("Local V1 process restart refuses the configured CONVEX_URL.");
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("refuses the configured CONVEX_URL")) {
      throw error;
    }
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    delay(STOP_TIMEOUT_MS).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function waitForListen(child: ChildProcess, output: { text: string }): Promise<void> {
  const deadline = Date.now() + LISTEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (output.text.includes("Jarvis HTTP is listening")) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Jarvis HTTP exited before listening.\n${output.text.slice(-2_000)}`);
    }
    await delay(50);
  }
  throw new Error(`Jarvis HTTP did not listen.\n${output.text.slice(-2_000)}`);
}

async function getBody(
  port: number,
  urlPath: string,
  serviceToken: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    headers: { authorization: `Bearer ${serviceToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.text() };
}

async function serveOnce(
  request: RestartedProcessRequest,
  port: number,
): Promise<RestartedProcessBody> {
  const output = { text: "" };
  const token = request.serviceToken ?? SERVICE_TOKEN;
  const child = spawn(process.execPath, ["--import", "tsx", "src/http/main.ts"], {
    cwd: typescriptRoot,
    env: childEnvironment(request, port, token),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output.text += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output.text += chunk;
  });
  try {
    await waitForListen(child, output);
    const client = await getBody(
      port,
      `/api/v1/clients/${encodeURIComponent(request.clientId)}`,
      token,
    );
    const task = await getBody(port, `/api/v1/tasks/${encodeURIComponent(request.taskId)}`, token);
    const build = await getBody(
      port,
      `/api/v1/builds/${encodeURIComponent(request.buildId)}`,
      token,
    );
    const quote = await getBody(
      port,
      `/api/v1/quotes/${encodeURIComponent(request.quoteId)}`,
      token,
    );
    if (client.status !== 200 || task.status !== 200 || build.status !== 200) {
      throw new Error(
        `Local V1 process restart HTTP read failed (${client.status}, ${task.status}, ${build.status}).`,
      );
    }
    if (request.isolatedConvexUrl === undefined && quote.status === 200) {
      throw new Error(
        "Local V1 process restart refuses to treat a quote GET as recovered without an isolated Convex backend.",
      );
    }
    if (request.isolatedConvexUrl !== undefined && quote.status !== 200) {
      throw new Error("Local V1 process restart quote GET failed.");
    }
    return {
      clientBody: client.body,
      taskBody: task.body,
      buildBody: build.body,
      quoteStatus: quote.status,
      quoteBody: quote.body,
    };
  } finally {
    await stopChild(child);
  }
}

/**
 * Spawns the existing HTTP entrypoint twice against one scratch JSON directory.
 * Client, task, and build GETs must match. Quote GETs are compared only when
 * `isolatedConvexUrl` names a backend that is not the configured deployment.
 */
export async function readRestartedProcess(
  request: RestartedProcessRequest,
): Promise<RestartedProcessResult> {
  const configured = request.configuredConvexUrl?.trim();
  if (configured === LOCAL_V1_RESTART_CONVEX_SENTINEL) {
    throw new Error("Local V1 process restart sentinel collides with the configured CONVEX_URL.");
  }
  const isolated = request.isolatedConvexUrl;
  if (isolated !== undefined) assertIsolatedConvexUrl(isolated, request.configuredConvexUrl);
  const token = request.serviceToken ?? SERVICE_TOKEN;
  if (token.length < 32) {
    throw new Error("Local V1 process restart service token is too short.");
  }
  const before = await localV1LiveDirectoryDigest(request.liveDirectory);
  const port = await freePort();
  const first = await serveOnce(request, port);
  const second = await serveOnce(request, port);
  if (
    first.clientBody !== second.clientBody ||
    first.taskBody !== second.taskBody ||
    first.buildBody !== second.buildBody ||
    (isolated !== undefined && first.quoteBody !== second.quoteBody)
  ) {
    throw new Error("Local V1 process restart did not match the first read.");
  }
  if ((await localV1LiveDirectoryDigest(request.liveDirectory)) !== before) {
    throw new Error("Local V1 process restart changed the live data directory.");
  }
  return { first, second, quoteRecovered: isolated !== undefined };
}
