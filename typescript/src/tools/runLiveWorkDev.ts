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

/**
 * Matches `LiveWorkResult`'s actual union shape — `{status:"available",
 * pipeline}` or `{status:"unavailable", reason}` — not just a recognized
 * `status` value, so a stale or incompatible service that happens to return
 * one of those two literal strings without the rest of the required shape
 * still fails closed instead of being treated as reachable.
 */
function isLiveWorkEnvelope(value: unknown): value is { data: { status: unknown } } {
  if (typeof value !== "object" || value === null) return false;
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  if (record.status === "available") return "pipeline" in record;
  if (record.status === "unavailable") return typeof record.reason === "string";
  return false;
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
  if (response.status !== 200) {
    // Exact 200, not `response.ok`'s whole 2xx range: the route only ever
    // returns 200, so accepting e.g. 201/206 could reuse an unrelated
    // service that coincidentally returns a 2xx with a status-shaped body.
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
  | { readonly kind: "free" }
  | { readonly kind: "occupied"; readonly code: "EADDRINUSE" }
  | { readonly kind: "check-failed"; readonly code: string };

/**
 * Only `EADDRINUSE` proves another process holds the port. Anything else
 * (`EACCES`, `EADDRNOTAVAIL`, ...) is a distinct configuration/permission
 * problem and must not be reported as "another process owns this port" —
 * that would point the operator at the wrong fix and imply refusing to
 * touch a process that was never actually found.
 */
export function classifyBindError(error: NodeJS.ErrnoException): PortAvailability {
  if (error.code === "EADDRINUSE") return { kind: "occupied", code: "EADDRINUSE" };
  return { kind: "check-failed", code: error.code ?? "UNKNOWN" };
}

/** Real TCP-level check: attempts to bind the configured host/port and immediately releases it. */
export function checkPortAvailability(host: string, port: number): Promise<PortAvailability> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolve(classifyBindError(error));
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
  const apiPort = api.baseUrl.port || "80";
  if (apiPort !== String(listen.port)) {
    throw new Error(
      `JARVIS_API_BASE_URL (${api.baseUrl.origin}) and the HTTP runtime's configured port ` +
        `(${listen.port}, from JARVIS_HTTP_PORT) do not agree. Point them at the same port before retrying.`,
    );
  }
  const listenHost = normalizeHost(listen.host);
  // A wildcard bind (0.0.0.0 / ::) serves every local address, loopback
  // included — JARVIS_API_BASE_URL naming a specific one (typically
  // 127.0.0.1, since that's all resolveApiBaseUrl itself ever allows) is
  // valid and reachable, not a mismatch, so only a non-wildcard host is
  // checked for equality.
  const isWildcardBind = listenHost === "0.0.0.0" || listenHost === "::";
  if (!isWildcardBind && normalizeHost(api.baseUrl.hostname) !== listenHost) {
    throw new Error(
      `JARVIS_API_BASE_URL (${api.baseUrl.origin}) and the HTTP runtime's configured host ` +
        `(${listen.host}, from JARVIS_HTTP_HOST) do not agree. Point them at the same host before retrying.`,
    );
  }
}

/** The subset of `ChildProcess` this module needs — narrow enough that tests can use a plain fake. */
export interface ChildProcessLike {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): void;
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

function exitedError(child: ChildProcessLike): Error {
  return new Error(
    `Jarvis HTTP runtime exited before it became ready ` +
      `(code ${String(child.exitCode)}${child.signalCode ? `, signal ${child.signalCode}` : ""}).`,
  );
}

/**
 * Rejects the moment `child` exits — checked at creation (it may have
 * already exited) and via a listener for any exit after that — so racing it
 * against an in-flight probe or delay reports a child crash immediately,
 * rather than only after that probe/delay happens to settle on its own
 * (which, for a probe with no response, could be its full timeout or
 * longer).
 */
function childExited(child: ChildProcessLike): Promise<never> {
  const promise = new Promise<never>((_resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(exitedError(child));
      return;
    }
    child.once("exit", () => reject(exitedError(child)));
  });
  promise.catch(() => undefined); // never an unhandled rejection if nothing races it in time
  return promise;
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
  const exited = childExited(child);
  for (;;) {
    const probe = await Promise.race([probeFn(api), exited]);
    if (probe.kind === "ready") {
      // A probe can itself take close to its own timeout, so it's possible
      // to receive `ready` only after the overall deadline already passed —
      // don't silently accept a startup that ran longer than `timeoutMs`.
      if (Date.now() < deadline) return;
      attempts.push("became ready only after the timeout had already elapsed");
      break;
    }
    attempts.push(probe.detail);
    if (Date.now() >= deadline) break;
    await Promise.race([delay(PROBE_INTERVAL_MS), exited]);
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
  readonly runMonitor: (argv: readonly string[], signal?: AbortSignal) => Promise<void>;
  readonly onSignal: (handler: () => void) => () => void;
}

/**
 * The full reuse/spawn/fail decision, startup wait, monitor handoff, and
 * cleanup — independent of `process`, real child processes, or a real
 * terminal, so every path is directly testable.
 */
export async function runLiveWorkDev(deps: LiveWorkDevDeps): Promise<void> {
  let child: ChildProcessLike | null = null;
  // A signal during the initial probe/port-check/wait phase must actually
  // stop startup, not just be silently absorbed — checked with
  // `rejectIfCancelled()` after every await in that phase below, since the
  // handler itself can't unwind an in-flight `await` on its own.
  let cancelled: Error | null = null;
  // Handed to the monitor so an operator's Ctrl+C during `--once` (which
  // installs no signal handler of its own) cancels its in-flight request
  // immediately, instead of waiting out the full request timeout.
  const monitorAbort = new AbortController();
  const removeSignalHandler = deps.onSignal(() => {
    cancelled ??= new Error(
      "Cancelled before the Jarvis HTTP runtime was ready — no live-work monitor was started.",
    );
    if (child) stopChild(child);
    monitorAbort.abort();
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
      // Endpoint consistency only matters once we're about to spawn our own
      // runtime — it exists to catch us spawning a server our own probe
      // could never reach. A healthy pre-existing runtime is reused above
      // regardless of how its host/port/scheme compares to the local listen
      // config, since nothing gets spawned in that case.
      assertConsistentEndpoint(deps.api, deps.listen);
      const availability = await deps.checkPort(deps.listen.host, deps.listen.port);
      rejectIfCancelled();
      if (availability.kind === "check-failed") {
        throw new Error(
          `Could not determine whether ${deps.listen.host}:${deps.listen.port} is free ` +
            `(${availability.code}). Check that JARVIS_HTTP_HOST/JARVIS_HTTP_PORT are valid and this ` +
            `process has permission to bind them.`,
        );
      }
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
    removeSignalHandler();
    throw error;
  }

  // The handler stays registered through the monitor itself, not just
  // startup: `--once` mode installs no signal handler of its own at all (only
  // the default loop mode does, for its terminal restore), so removing ours
  // beforehand would leave a Ctrl+C during a one-shot request free to kill
  // this process before the `finally` below ever runs, orphaning a child we
  // started. Coexisting with the loop mode's own handler is harmless — this
  // one only stops our child and never touches the terminal or calls exit.
  try {
    await deps.runMonitor(deps.argv, monitorAbort.signal);
  } finally {
    if (child) stopChild(child);
    removeSignalHandler();
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
