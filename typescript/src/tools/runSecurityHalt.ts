import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { FileHaltStore, HALT_FILE_BASENAME, type HaltReading } from "../security/haltControl.js";

/**
 * `npm run sec -- halt "<reason>" | resume "<reason>" | status` (#839).
 *
 * Writes or reads the owner halt record that every governed tool execution
 * checks before dispatch. It talks to no service, network, or provider. A
 * running NOLAN service picks the record up on its next execution attempt,
 * with no restart.
 */
export const SECURITY_HALT_USAGE = [
  "Usage:",
  '  npm run sec -- halt "<reason>"    block new governed dispatch',
  '  npm run sec -- resume "<reason>"  allow governed dispatch again',
  "  npm run sec -- status             show the current halt record",
].join("\n");

export type SecurityHaltIo = {
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
};

export function describeHalt(reading: HaltReading): string {
  if (!reading.halted) {
    return reading.record === null
      ? "Dispatch: running (no halt record)."
      : `Dispatch: running (resumed ${reading.record.changedAt}: ${reading.record.reason}).`;
  }
  if (reading.record === null) {
    return `Dispatch: HALTED (fail closed: ${reading.failClosed ?? "halt record unreadable"}).`;
  }
  return [
    `Dispatch: HALTED (requested ${reading.record.changedAt}: ${reading.record.reason}).`,
    "New governed tool executions are refused. In-flight work is not cancelled, so this is not a verified stop.",
  ].join("\n");
}

export async function runSecurityHalt(
  argv: readonly string[],
  store: FileHaltStore,
  io: SecurityHaltIo,
): Promise<number> {
  const [command, ...rest] = argv;
  const now = io.now ?? (() => new Date());
  try {
    if (command === "status" && rest.length === 0) {
      io.out(describeHalt(await store.read()));
      return 0;
    }
    if ((command === "halt" || command === "resume") && rest.length === 1) {
      const reason = rest[0] ?? "";
      if (command === "halt") await store.halt(reason, now());
      else await store.resume(reason, now());
      io.out(describeHalt(await store.read()));
      return 0;
    }
  } catch (error: unknown) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  io.err(SECURITY_HALT_USAGE);
  return 2;
}

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(): Promise<number> {
  // The service reads JARVIS_DATA_DIR from its environment file. Load the same
  // `.env.local` before resolving the data directory (resolved at import time),
  // so the owner's record lands in the file the service checks.
  loadLocalEnvironment();
  const { jarvisDataFile } = await import("../persistence/jarvisDataPaths.js");
  const store = new FileHaltStore(jarvisDataFile(HALT_FILE_BASENAME));
  return runSecurityHalt(process.argv.slice(2), store, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
