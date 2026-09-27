/**
 * ACP worker launch configuration (roadmap PR H, slice 4).
 *
 * Resolves — fail-closed, from the environment — the command and argv used to
 * launch a local ACP worker (Claude/Codex) for {@link spawnAcpChild}. Like PR F's
 * credential resolver, this slice only *reads config*: it launches no process,
 * opens no network, and returns `null` until an owner provisions the env. The
 * worker's own model/API egress is a separate governed concern and is neither
 * granted nor broadened here.
 *
 * Args are a JSON array of strings and are passed to the worker as literal argv
 * (via `child_process.spawn` with no shell), so a value with spaces or shell
 * metacharacters is one argument, not a shell expression — there is no shell
 * injection surface. A missing command, a blank command, or an args value that
 * is not a JSON array of strings all resolve to `null`.
 */

import type { AcpWorkerConfig } from "./acpStdioTransport.js";

type Environment = Readonly<Record<string, string | undefined>>;

function parseArgs(raw: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    return null;
  }
  return Object.freeze([...(parsed as string[])]);
}

/**
 * Resolve an {@link AcpWorkerConfig} from the environment, fail-closed. Reads
 * `${prefix}_COMMAND` (required, trimmed, non-blank) and `${prefix}_ARGS` (an
 * optional JSON array of strings; absent → `[]`). Returns `null` unless the
 * command is present and non-blank and any provided args are a valid JSON array
 * of strings. The `prefix` lets a caller resolve several distinct workers.
 */
export function resolveAcpWorkerConfigFromEnv(
  environment: Environment = process.env,
  options: { prefix?: string } = {},
): AcpWorkerConfig | null {
  const prefix = options.prefix ?? "JARVIS_ACP_WORKER";
  const command = environment[`${prefix}_COMMAND`]?.trim();
  if (!command) return null;

  const rawArgs = environment[`${prefix}_ARGS`];
  let args: readonly string[];
  if (rawArgs === undefined) {
    args = [];
  } else {
    const parsed = parseArgs(rawArgs);
    if (!parsed) return null;
    args = parsed;
  }

  return Object.freeze({ command, args });
}
