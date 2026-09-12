/**
 * One-command development runtime for the live-work terminal monitor.
 *
 *   npm run dev:live-work                 # same flags as `npm run monitor`
 *   npm run dev:live-work -- --once
 *   npm run dev:live-work -- --interval 2 --no-color --width 100
 *
 * Removes the operator step of managing the Jarvis HTTP runtime by hand
 * before running the monitor:
 *
 * 1. Probes the configured `JARVIS_API_BASE_URL` for the current
 *    `GET /api/v1/development/live-work` route. If it already answers with
 *    a well-formed Jarvis payload, that runtime is reused as-is — no second
 *    server is started.
 * 2. Otherwise, checks whether the configured `JARVIS_HTTP_HOST`/
 *    `JARVIS_HTTP_PORT` is free. If something else already owns it, this
 *    exits with an explicit error and never touches that process.
 * 3. If the port is free, starts `src/http/main.ts` as a child process and
 *    waits for the live-work route to become reachable.
 * 4. Runs the existing terminal monitor (`runLiveWorkMonitor.ts`) in-process,
 *    with the same argument parsing and terminal handling, so its flags and
 *    behaviour are unchanged.
 * 5. On exit — Ctrl+C, `--once` completing, or a startup failure — cleans up
 *    only the HTTP child this command itself started. A reused runtime is
 *    never touched.
 *
 * Uses the same `.env.local`, `JARVIS_HTTP_PORT`, `JARVIS_API_BASE_URL`, and
 * service-token configuration paths as the HTTP runtime and monitor already
 * use; it adds no parallel configuration surface of its own.
 *
 * `runLiveWorkDev` below takes every effect (probing, port checks, spawning,
 * signal handling, running the monitor) as injected dependencies so the
 * reuse/spawn/fail decision, cleanup, and argument forwarding can be tested
 * without a real HTTP runtime, a real child process, or a real terminal.
 * `main()` at the bottom is the thin CLI wrapper that supplies the real ones.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { loadEnvFile } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { resolveHttpListenConfig, type HttpListenConfig } from "../http/config.js";
import { resolveJarvisMcpConfig, type JarvisApiConfig } from "../mcp/config.js";
import { main as runLiveWorkMonitor } from "./runLiveWorkMonitor.js";

const HTTP_STARTUP_TIMEOUT_MS = 20_000;
const PROBE_INTERVAL_MS = 300;
const PROBE_TIMEOUT_MS = 2_000;
const OUTPUT_TAIL_LINES = 40;

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type LiveWorkProbeOutcome =
  { readonly kind: "ready" } | { readonly kind: "not-ready"; readonly detail: string };

function isLiveWorkEnvelope(value: unknown): value is { data: { status: unknown } } {
  if (typeof value !== "object" || value === null) return false;
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  const status = (data as { status?: unknown }).status;
  return status === "available" || status === "unavailable";
}

/**
 * Probes the current `GET /api/v1/development/live-work` route directly
 * (not through `JarvisApiClient`, whose error handling collapses "nothing is
 * listening" and "something answered with an error" into overlapping
 * shapes). Any transport-level failure and any well-formed-but-wrong
 * response are both reported as `not-ready` with an explanatory `detail` —
 * distinguishing "reuse this" from "something else is here" is left to the
 * caller, which also has a real TCP-level port check available.
 */
export async function probeLiveWork(
  api: JarvisApiConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<LiveWorkProbeOutcome> {
  const url = new URL("api/v1/development/live-work", api.baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${api.serviceToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    return { kind: "not-ready", detail: `no response from ${url.origin} (${errorMessage(error)})` };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      kind: "not-ready",
      detail: `${url.origin} rejected the configured JARVIS_SERVICE_TOKEN (HTTP ${response.status})`,
    };
  }
  if (!response.ok) {
    return {
      kind: "not-ready",
      detail: `${url.pathname} returned HTTP ${response.status} on ${url.origin}`,
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      kind: "not-ready",
      detail: `${url.pathname} on ${url.origin} did not return valid JSON`,
    };
  }
  if (!isLiveWorkEnvelope(payload)) {
    return {
      kind: "not-ready",
      detail: `${url.pathname} on ${url.origin} responded, but not with the expected Jarvis live-work payload`,
    };
  }
  return { kind: "ready" };
}

export type PortAvailability =
  { readonly kind: "free" } | { readonly kind: "occupied"; readonly code: string };

/** Real TCP-level check: attempts to bind the configured host/port and immediately releases it. */
export function checkPortAvailability(host: string, port: number): Promise<PortAvailability> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ kind: "occupied", code: error.code ?? "UNKNOWN" });
    });
    probe.once("listening", () => {
      probe.close(() => resolve({ kind: "free" }));
    });
    probe.listen(port, host);
  });
}

function normalizeHost(host: string): string {
  const trimmed = host.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unbracketed.toLowerCase();
}

/**
 * `src/http/main.ts` only ever speaks plain HTTP and binds exactly one
 * host/port — if `JARVIS_API_BASE_URL` names a different host, a different
 * port, or `https:`, the launcher would spawn a runtime the probe can never
 * reach (an https probe against a plain-HTTP listener, or a probe aimed at
 * an address nothing is bound to) and spin until the startup timeout with an
 * unhelpful "no response" detail instead of rejecting the mismatch upfront.
 */
export function assertConsistentEndpoint(api: JarvisApiConfig, listen: HttpListenConfig): void {
  if (api.baseUrl.protocol !== "http:") {
    throw new Error(
      `JARVIS_API_BASE_URL (${api.baseUrl.origin}) uses ${api.baseUrl.protocol.replace(":", "")}, ` +
        `but the Jarvis HTTP runtime this launcher may start only ever speaks plain HTTP. ` +
        `Point JARVIS_API_BASE_URL at an http:// URL before retrying.`,
    );
  }
  const apiHost = normalizeHost(api.baseUrl.hostname);
  const apiPort = api.baseUrl.port || "80";
  if (apiHost !== normalizeHost(listen.host) || apiPort !== String(listen.port)) {
    throw new Error(
      `JARVIS_API_BASE_URL (${api.baseUrl.origin}) and the HTTP runtime's configured address ` +
        `(${listen.host}:${listen.port}, from JARVIS_HTTP_HOST/JARVIS_HTTP_PORT) do not agree. ` +
        `Point them at the same host and port before retrying.`,
    );
  }
}

/** The subset of `ChildProcess` this module needs — narrow enough that tests can use a plain fake. */
export interface ChildProcessLike {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
}

export function stopChild(child: ChildProcessLike): void {
  if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill("SIGTERM");
}

function spawnHttpRuntime(env: NodeJS.ProcessEnv): { child: ChildProcessLike; tail: () => string } {
  const child = spawn(process.execPath, ["--import", "tsx", "src/http/main.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const capture = (chunk: Buffer): void => {
    lines.push(
      ...chunk
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0),
    );
    while (lines.length > OUTPUT_TAIL_LINES) lines.shift();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, tail: () => lines.join("\n") };
}

/** Polls `probeFn` until it reports `ready`, the child exits, or `timeoutMs` elapses. */
export async function waitForHttpReady(
  api: JarvisApiConfig,
  child: ChildProcessLike,
  timeoutMs = HTTP_STARTUP_TIMEOUT_MS,
  probeFn: typeof probeLiveWork = probeLiveWork,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const attempts: string[] = ["no probe attempted yet"];
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Jarvis HTTP runtime exited before it became ready ` +
          `(code ${String(child.exitCode)}${child.signalCode ? `, signal ${child.signalCode}` : ""}).`,
      );
    }
    const probe = await probeFn(api);
    if (probe.kind === "ready") return;
    attempts.push(probe.detail);
    if (Date.now() >= deadline) break;
    await delay(PROBE_INTERVAL_MS);
  }
  throw new Error(
    `Jarvis HTTP runtime did not become ready within ${Math.round(timeoutMs / 1000)}s ` +
      `(last probe: ${attempts[attempts.length - 1]}).`,
  );
}

export interface LiveWorkDevDeps {
  readonly api: JarvisApiConfig;
  readonly listen: HttpListenConfig;
  readonly argv: readonly string[];
  readonly log: (message: string) => void;
  readonly probe: typeof probeLiveWork;
  readonly checkPort: typeof checkPortAvailability;
  readonly spawnHttp: () => { child: ChildProcessLike; tail: () => string };
  readonly waitForReady: (api: JarvisApiConfig, child: ChildProcessLike) => Promise<void>;
  readonly runMonitor: (argv: readonly string[]) => Promise<void>;
  readonly onSignal: (handler: () => void) => () => void;
}

/**
 * The full reuse/spawn/fail decision, startup wait, monitor handoff, and
 * cleanup — independent of `process`, real child processes, or a real
 * terminal, so every path is directly testable.
 */
export async function runLiveWorkDev(deps: LiveWorkDevDeps): Promise<void> {
  assertConsistentEndpoint(deps.api, deps.listen);

  let child: ChildProcessLike | null = null;
  // A signal during the initial probe/port-check/wait phase must actually
  // stop startup, not just be silently absorbed — checked with
  // `rejectIfCancelled()` after every await in that phase below, since the
  // handler itself can't unwind an in-flight `await` on its own.
  let cancelled: Error | null = null;
  const removeEarlySignalHandler = deps.onSignal(() => {
    cancelled ??= new Error(
      "Cancelled before the Jarvis HTTP runtime was ready — no live-work monitor was started.",
    );
    if (child) stopChild(child);
  });
  const rejectIfCancelled = (): void => {
    if (cancelled) throw cancelled;
  };

  try {
    const initialProbe = await deps.probe(deps.api);
    rejectIfCancelled();
    if (initialProbe.kind === "ready") {
      deps.log(`Reusing an already healthy Jarvis HTTP runtime at ${deps.api.baseUrl.origin}.`);
    } else {
      const availability = await deps.checkPort(deps.listen.host, deps.listen.port);
      rejectIfCancelled();
      if (availability.kind === "occupied") {
        throw new Error(
          `${deps.listen.host}:${deps.listen.port} is already in use by another process ` +
            `(${availability.code}), and it is not serving the Jarvis live-work route ` +
            `(${initialProbe.detail}). Refusing to start a duplicate runtime or touch that process. ` +
            `Free the port, or point JARVIS_HTTP_PORT and JARVIS_API_BASE_URL at a free one, then retry.`,
        );
      }

      const spawned = deps.spawnHttp();
      child = spawned.child;
      // No `await` since `spawnHttp()` returned, so a signal could not have
      // interleaved before this check — but one may have arrived while
      // `child` was still null (during the probe/port-check above), in which
      // case the handler above never got to stop *this* child.
      rejectIfCancelled();
      deps.log(
        `Starting the Jarvis HTTP runtime on http://${deps.listen.host}:${deps.listen.port} ...`,
      );
      try {
        await deps.waitForReady(deps.api, child);
      } catch (error: unknown) {
        const tail = spawned.tail();
        throw new Error(
          `${errorMessage(error)}${tail ? `\n--- Jarvis HTTP output ---\n${tail}` : ""}`,
          { cause: error },
        );
      }
      rejectIfCancelled();
      deps.log("Jarvis HTTP runtime is ready.");
    }
  } catch (error: unknown) {
    if (child) stopChild(child);
    removeEarlySignalHandler();
    throw error;
  }

  // From here the monitor (in its default loop mode) owns Ctrl+C for its own
  // terminal restore; the early startup-only handler above is no longer
  // needed. Once mode or loop mode alike, the `finally` below always cleans
  // up a child *we* started the moment the monitor returns control.
  removeEarlySignalHandler();

  try {
    await deps.runMonitor(deps.argv);
  } finally {
    if (child) stopChild(child);
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const mcpConfig = resolveJarvisMcpConfig();
  const listen = resolveHttpListenConfig();

  await runLiveWorkDev({
    api: mcpConfig.api,
    listen,
    argv: process.argv.slice(2),
    log: (message) => console.log(message),
    probe: probeLiveWork,
    checkPort: checkPortAvailability,
    spawnHttp: () => spawnHttpRuntime(process.env),
    waitForReady: waitForHttpReady,
    runMonitor: runLiveWorkMonitor,
    onSignal: (handler) => {
      process.once("SIGINT", handler);
      process.once("SIGTERM", handler);
      return () => {
        process.removeListener("SIGINT", handler);
        process.removeListener("SIGTERM", handler);
      };
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`Jarvis live-work launcher failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
