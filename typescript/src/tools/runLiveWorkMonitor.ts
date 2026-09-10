/**
 * Terminal live-work monitor — the console twin of the "Live Work" HUD view.
 *
 *   npm run monitor                 # full-screen, refreshes every 5s
 *   npm run monitor -- --once       # print one frame and exit (pipe-friendly)
 *   npm run monitor -- --interval 2 # refresh every 2s
 *   npm run monitor -- --no-color --width 100
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

export interface MonitorArgs {
  readonly once: boolean;
  readonly intervalMs: number;
  readonly color: boolean;
  readonly width?: number;
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
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return { once, color, intervalMs: Math.round(intervalSeconds * 1000), width };
}

/** Fetches one snapshot, mapping any transport failure to a truthful UNAVAILABLE. */
export async function fetchLiveWork(client: {
  getDevelopmentLiveWork(): Promise<LiveWorkResult>;
}): Promise<LiveWorkResult> {
  try {
    return await client.getDevelopmentLiveWork();
  } catch (error: unknown) {
    return { status: "unavailable", reason: `Could not reach Jarvis: ${errorMessage(error)}` };
  }
}

function resolveWidth(args: MonitorArgs): number | undefined {
  return args.width ?? (process.stdout.columns ? process.stdout.columns - 1 : undefined);
}

async function runOnce(client: JarvisApiClient, args: MonitorArgs): Promise<void> {
  const result = await fetchLiveWork(client);
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
      const result = await fetchLiveWork(client);
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

async function main(): Promise<void> {
  loadLocalEnvironment();
  const args = parseMonitorArgs(process.argv.slice(2));
  const client = new JarvisApiClient(resolveJarvisMcpConfig().api);
  if (args.once) {
    await runOnce(client, args);
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
