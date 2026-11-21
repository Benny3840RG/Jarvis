import { execFile } from "node:child_process";

import { PRIVILEGED_SERVICES, type ServiceHealthObservation } from "./privilegedOperationPolicy.js";

/**
 * NOLAN guardian (#839), read-only service status.
 *
 * Turns `systemctl --user show` for a code-allowlisted unit into the
 * `ServiceHealthObservation` the privileged-operation policy consumes. It
 * only reads: one fixed argument list, `execFile` with no shell, a short
 * timeout and bounded output. It never restarts anything and has no
 * production caller yet.
 *
 * It is deliberately conservative. Only a `failed` unit, or one stuck in
 * `activating/auto-restart`, is unhealthy. A unit the owner stopped, or one
 * that is changing state, is `unknown`, so the policy never "repairs" a
 * deliberate stop. Any error or unexpected output is `unknown`, never healthy.
 */

/** Absolute path, so `PATH` cannot redirect the binary. */
export const SYSTEMCTL_PATH = "/usr/bin/systemctl";
export const STATUS_TIMEOUT_MS = 3_000;
export const STATUS_MAX_BYTES = 4_096;

const PROPERTIES = ["LoadState", "ActiveState", "SubState", "NRestarts"] as const;

/** systemd's ActiveState values; anything else is malformed evidence. */
const ACTIVE_STATES = new Set([
  "active",
  "reloading",
  "inactive",
  "failed",
  "activating",
  "deactivating",
  "maintenance",
  "refreshing",
]);
/** A systemd state token: lowercase words joined by single hyphens, never empty. */
const STATE_TOKEN = /^[a-z]+(?:-[a-z]+)*$/;

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBytes: number },
) => Promise<string>;

export class GuardianStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardianStatusError";
  }
}

export type ServiceStatusEvidence = {
  loadState?: string;
  activeState?: string;
  subState?: string;
  restarts?: number;
};

export type ServiceStatusReading = {
  observation: ServiceHealthObservation;
  evidence: ServiceStatusEvidence;
};

type AllowlistedService = (typeof PRIVILEGED_SERVICES)[number];

function isAllowlisted(value: unknown): value is AllowlistedService {
  return typeof value === "string" && (PRIVILEGED_SERVICES as readonly string[]).includes(value);
}

/** Minimal environment: only what `systemctl --user` needs to reach the user manager. */
function userManagerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C" };
  if (process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  if (process.env.DBUS_SESSION_BUS_ADDRESS) {
    env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  }
  return env;
}

export const execFileRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        shell: false,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        env: userManagerEnv(),
        encoding: "utf8",
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** Parses `KEY=VALUE` lines; any duplicate, missing or malformed property yields null. */
function parseShow(output: string): Required<ServiceStatusEvidence> | null {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) return null;
    const key = line.slice(0, separator);
    if (!(PROPERTIES as readonly string[]).includes(key) || values.has(key)) return null;
    values.set(key, line.slice(separator + 1));
  }
  if (PROPERTIES.some((key) => !values.has(key))) return null;
  const restarts = values.get("NRestarts")!;
  if (!/^\d{1,9}$/.test(restarts)) return null;
  const loadState = values.get("LoadState")!;
  const activeState = values.get("ActiveState")!;
  const subState = values.get("SubState")!;
  if (![loadState, activeState, subState].every((value) => STATE_TOKEN.test(value))) return null;
  if (!ACTIVE_STATES.has(activeState)) return null;
  return {
    loadState: values.get("LoadState")!,
    activeState: values.get("ActiveState")!,
    subState: values.get("SubState")!,
    restarts: Number(restarts),
  };
}

function classify(evidence: Required<ServiceStatusEvidence>): ServiceHealthObservation["state"] {
  if (evidence.loadState !== "loaded") return "unknown";
  if (evidence.activeState === "active" && evidence.subState === "running") return "healthy";
  if (evidence.activeState === "failed" && evidence.subState === "failed") return "unhealthy";
  if (evidence.activeState === "activating" && evidence.subState === "auto-restart") {
    return "unhealthy";
  }
  return "unknown";
}

export async function readServiceHealth(
  service: unknown,
  deps: { run?: CommandRunner; now?: () => string } = {},
): Promise<ServiceStatusReading> {
  if (!isAllowlisted(service)) {
    throw new GuardianStatusError("Only allowlisted services can be inspected.");
  }
  const run = deps.run ?? execFileRunner;
  const now = deps.now ?? (() => new Date().toISOString());
  let output: string | null;
  try {
    output = await run(
      SYSTEMCTL_PATH,
      ["--user", "show", service, `--property=${PROPERTIES.join(",")}`, "--no-pager"],
      { timeoutMs: STATUS_TIMEOUT_MS, maxBytes: STATUS_MAX_BYTES },
    );
  } catch {
    output = null;
  }
  // Observed after the read completes, so freshness never predates the evidence.
  const observedAt = now();
  const evidence = output === null ? null : parseShow(output);
  return {
    observation: { service, state: evidence ? classify(evidence) : "unknown", observedAt },
    evidence: evidence ?? {},
  };
}
