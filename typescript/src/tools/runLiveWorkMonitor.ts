/**
 * Terminal live-work monitor — the console twin of the "Live Work" HUD view.
 *
 *   npm run monitor                 # full-screen, refreshes every 5s
 *   npm run monitor -- --once       # print one frame and exit (pipe-friendly)
 *   npm run monitor -- --interval 2 # refresh every 2s
 *   npm run monitor -- --no-color --width 100
 *   npm run monitor -- --timeout 15 # give a slow link longer before UNAVAILABLE
 *
 * Reads the same `GET /api/v1/development/live-work` endpoint the browser HUD
 * uses (`JARVIS_API_BASE_URL` + `JARVIS_SERVICE_TOKEN`, from `.env.local`).
 * All rendering lives in the pure `renderLiveWorkTerminal`; this file is just
 * the polling shell and the terminal plumbing.
 */

import { loadEnvFile } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { renderLiveWorkTerminal } from "../development/liveWorkTerminal.js";
import type { LiveWorkResult } from "../development/liveWork.js";
import { resolveJarvisMcpConfig } from "../mcp/config.js";
import { JarvisApiClient } from "../mcp/jarvisApiClient.js";

const ESC = String.fromCharCode(27);
const ENTER_FULLSCREEN = `${ESC}[?1049h${ESC}[?25l`;
const EXIT_FULLSCREEN = `${ESC}[?25h${ESC}[?1049l`;
const HOME_AND_CLEAR = `${ESC}[H${ESC}[2J`;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * `JarvisApiClient`'s underlying `fetch` has no timeout of its own — a host
 * that accepts the connection but never responds (dead server, silently
 * dropped packets, wrong port left open) would otherwise leave `await
 * fetchLiveWork(...)` pending forever, which looks exactly like the monitor
 * "hanging" on the first frame. `fetchLiveWork` below always settles within
 * `timeoutMs`.
 */
const DEFAULT_TIMEOUT_MS = 8000;

export interface MonitorArgs {
  readonly once: boolean;
  readonly intervalMs: number;
  readonly color: boolean;
  readonly width?: number;
  readonly timeoutMs: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

/** Parses `argv` (already sliced past `node script`). Throws on malformed input. */
export function parseMonitorArgs(argv: readonly string[]): MonitorArgs {
  let once = false;
  let color = true;
  let intervalSeconds = 5;
  let width: number | undefined;
  let timeoutSeconds = DEFAULT_TIMEOUT_MS / 1000;

  const readValue = (
    flag: string,
    inline: string | undefined,
    index: { value: number },
  ): string => {
    if (inline !== undefined) return inline;
    const next = argv[index.value + 1];
    if (next === undefined) throw new Error(`${flag} needs a value.`);
    index.value += 1;
    return next;
  };

  const cursor = { value: 0 };
  for (; cursor.value < argv.length; cursor.value += 1) {
    const token = argv[cursor.value] ?? "";
    const [flag, inline] = token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, undefined];
    switch (flag) {
      case "--once":
        once = true;
        break;
      case "--no-color":
        color = false;
        break;
      case "--color":
        color = true;
        break;
      case "--interval": {
        const seconds = Number(readValue(flag, inline, cursor));
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
          throw new Error("--interval must be a number of seconds between 1 and 3600.");
        }
        intervalSeconds = seconds;
        break;
      }
      case "--width": {
        const columns = Number(readValue(flag, inline, cursor));
        if (!Number.isInteger(columns) || columns < 40 || columns > 200) {
          throw new Error("--width must be an integer between 40 and 200.");
        }
        width = columns;
        break;
      }
      case "--timeout": {
        const seconds = Number(readValue(flag, inline, cursor));
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) {
          throw new Error("--timeout must be a number of seconds between 1 and 120.");
        }
        timeoutSeconds = seconds;
        break;
      }
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return {
    once,
    color,
    intervalMs: Math.round(intervalSeconds * 1000),
    width,
    timeoutMs: Math.round(timeoutSeconds * 1000),
  };
}

/**
 * Fetches one snapshot. Always settles within `timeoutMs` and maps any
 * transport failure — including a request that never responds — to a
 * truthful UNAVAILABLE, never leaving the caller awaiting forever.
 */
export async function fetchLiveWork(
  client: { getDevelopmentLiveWork(signal?: AbortSignal): Promise<LiveWorkResult> },
  timeoutMs = DEFAULT_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<LiveWorkResult> {
  // Cancelled before this call even started: settle immediately without ever
  // invoking `client.getDevelopmentLiveWork` — an already-cancelled request
  // must not still reach the client (and, transitively, the network).
  if (externalSignal?.aborted) {
    return {
      status: "unavailable",
      reason: "Could not reach Jarvis: Cancelled before Jarvis responded.",
    };
  }

  // The controller's signal is handed to the client so a real request can
  // actually cancel itself on timeout (rather than being merely outraced and
  // left running — in `runLoop`, an uncancelled request would otherwise pile
  // up with every subsequent poll); the `setTimeout` below is the backstop
  // that guarantees this function still settles within `timeoutMs` even
  // against a client that ignores the signal entirely. `externalSignal` (used
  // by `--once`, which installs no SIGINT handler of its own) lets an
  // operator's Ctrl+C cancel an in-flight request immediately too, instead of
  // leaving the process waiting out the full timeout.
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onExternalAbort: (() => void) | undefined;
  const raceCandidates: Promise<LiveWorkResult>[] = [];

  if (externalSignal) {
    raceCandidates.push(
      new Promise<never>((_resolve, reject) => {
        onExternalAbort = (): void => {
          controller.abort();
          reject(new Error("Cancelled before Jarvis responded."));
        };
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }),
    );
  }

  raceCandidates.push(
    // Wrapped in an async IIFE so a client that throws synchronously (rather
    // than returning a rejected promise) still becomes a rejected race
    // candidate instead of throwing out of `fetchLiveWork` itself, which
    // would bypass the try/catch below and break this function's contract of
    // always settling with a result, never throwing.
    // `Promise.race` attaches its own handler to each candidate, so a losing
    // promise that later rejects is never "unhandled".
    (async () => client.getDevelopmentLiveWork(controller.signal))(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Jarvis did not respond within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
    }),
  );

  try {
    return await Promise.race(raceCandidates);
  } catch (error: unknown) {
    return { status: "unavailable", reason: `Could not reach Jarvis: ${errorMessage(error)}` };
  } finally {
    clearTimeout(timer);
    if (onExternalAbort) externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function resolveWidth(args: MonitorArgs): number | undefined {
  return args.width ?? (process.stdout.columns ? process.stdout.columns - 1 : undefined);
}

async function runOnce(
  client: JarvisApiClient,
  args: MonitorArgs,
  signal?: AbortSignal,
): Promise<void> {
  const result = await fetchLiveWork(client, args.timeoutMs, signal);
  process.stdout.write(
    `${renderLiveWorkTerminal(result, { color: args.color, width: resolveWidth(args) })}\n`,
  );
}

async function runLoop(client: JarvisApiClient, args: MonitorArgs): Promise<void> {
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const restore = (): void => {
    process.stdout.write(EXIT_FULLSCREEN);
  };
  process.once("exit", restore);
  process.stdout.write(ENTER_FULLSCREEN);

  const seconds = Math.round(args.intervalMs / 1000);
  try {
    for (let tick = 0; !abort.signal.aborted; tick += 1) {
      const result = await fetchLiveWork(client, args.timeoutMs);
      if (abort.signal.aborted) break;
      const footer = `${SPINNER[tick % SPINNER.length]}  refreshing every ${seconds}s   ·   Ctrl+C to exit`;
      const frame = renderLiveWorkTerminal(result, {
        color: args.color,
        width: resolveWidth(args),
      });
      process.stdout.write(`${HOME_AND_CLEAR}${frame}\n\n${footer}\n`);
      // Resolves early (rejecting with AbortError) the moment Ctrl+C arrives.
      await delay(args.intervalMs, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("exit", restore);
    restore();
  }
}

/**
 * Runs the monitor for one process lifetime, exactly as the `npm run
 * monitor` CLI entry point below does. Exported so other launchers (the
 * one-command dev runtime in `runLiveWorkDev.ts`) can start the same
 * monitor, with the same flags, in-process — rather than re-implementing
 * or forking its argument parsing, polling, or terminal handling.
 *
 * `signal`, if given, lets that caller cancel a `--once` request early —
 * `--once` installs no SIGINT/SIGTERM handler of its own (only the default
 * loop mode does, for its own terminal restore), so without this an external
 * Ctrl+C would otherwise have to wait out the full request timeout.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  signal?: AbortSignal,
): Promise<void> {
  loadLocalEnvironment();
  const args = parseMonitorArgs(argv);
  const client = new JarvisApiClient(resolveJarvisMcpConfig().api);
  if (args.once) {
    await runOnce(client, args, signal);
    return;
  }
  await runLoop(client, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stdout.write(EXIT_FULLSCREEN);
    console.error(`Live-work monitor failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
