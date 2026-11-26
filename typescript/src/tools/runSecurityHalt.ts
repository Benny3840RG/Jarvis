import { loadEnvFile } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { FileHaltStore, HALT_FILE_BASENAME, type HaltReading } from "../security/haltControl.js";
import {
  FileHaltAckStore,
  HALT_ACK_FILE_BASENAME,
  haltRefFor,
  type HaltAckReading,
} from "../security/haltSupervisor.js";

/**
 * `npm run sec -- halt "<reason>" | resume "<reason>" | status` (#839).
 *
 * Writes or reads the owner halt record that every governed tool execution
 * checks before dispatch, and reads the running service's acknowledgement.
 * It talks to no service, network, or provider; the service polls the record
 * and cancels its in-flight governed executions and registered background
 * runtimes, with no service restart.
 */
export const SECURITY_HALT_USAGE = [
  "Usage:",
  '  npm run sec -- halt "<reason>"    block new governed dispatch and cancel running work',
  '  npm run sec -- resume "<reason>"  allow governed dispatch again',
  "  npm run sec -- status             show requested, acknowledged and verified-stopped state",
].join("\n");

/** How long `halt` waits for the service to report verified stopped. */
export const HALT_ACK_WAIT_MS = 5_000;
const HALT_ACK_POLL_MS = 250;

export type SecurityHaltIo = {
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export function describeHalt(
  reading: HaltReading,
  ackReading: HaltAckReading = { kind: "none" },
): string {
  if (!reading.halted) {
    return reading.record === null
      ? "Dispatch: running (no halt record)."
      : `Dispatch: running (resumed ${reading.record.changedAt}: ${reading.record.reason}).`;
  }
  const requested =
    reading.record === null
      ? `Dispatch: HALTED (fail closed: ${reading.failClosed ?? "halt record unreadable"}).`
      : `Dispatch: HALTED (requested ${reading.record.changedAt}: ${reading.record.reason}).`;
  return [requested, "New governed tool executions are refused.", describeAck(reading, ackReading)]
    .filter((line) => line.length > 0)
    .join("\n");
}

function describeAck(reading: HaltReading, ackReading: HaltAckReading): string {
  if (ackReading.kind === "unreadable") {
    return `Service: NOT ACKNOWLEDGED (acknowledgement file ${ackReading.problem}). Not a verified stop.`;
  }
  const haltRef = haltRefFor(reading);
  if (haltRef === undefined) {
    return "Service: cannot be verified (the halt record cannot be identified, so no acknowledgement can be matched to it). Not a verified stop.";
  }
  const ack = ackReading.kind === "ack" ? ackReading.ack : undefined;
  if (ack === undefined || ack.haltRef !== haltRef) {
    return "Service: not acknowledged yet. A running NOLAN service acknowledges within a few seconds; if this persists, the service is not running or cannot write its data directory. Not a verified stop.";
  }
  const cancelled = `${ack.cancelledExecutions} governed execution${ack.cancelledExecutions === 1 ? "" : "s"} cancelled`;
  const runtimes = `${ack.stoppedRuntimes} background runtime${ack.stoppedRuntimes === 1 ? "" : "s"} stopped`;
  if (ack.verifiedStoppedAt === null) {
    return [
      `Service (pid ${ack.pid}): acknowledged ${ack.acknowledgedAt}; ${cancelled}; ${runtimes}.`,
      `Waiting for ${ack.unsettledExecutions} effect${ack.unsettledExecutions === 1 ? "" : "s"} to settle (last checked ${ack.updatedAt}). Not yet a verified stop.`,
    ].join("\n");
  }
  return [
    `Service (pid ${ack.pid}): VERIFIED STOPPED ${ack.verifiedStoppedAt} (acknowledged ${ack.acknowledgedAt}; ${cancelled}; ${runtimes}).`,
    "Covers governed tool executions and registered background runtimes in the service process. A cancelled execution ends with an unknown outcome; check its receipt before retrying.",
  ].join("\n");
}

async function waitForVerifiedStop(
  store: FileHaltStore,
  acks: FileHaltAckStore,
  sleep: (ms: number) => Promise<void>,
): Promise<{ reading: HaltReading; ack: HaltAckReading }> {
  const deadline = Date.now() + HALT_ACK_WAIT_MS;
  for (;;) {
    const reading = await store.read();
    const ack = await acks.read();
    const verified =
      ack.kind === "ack" &&
      ack.ack.haltRef === haltRefFor(reading) &&
      ack.ack.verifiedStoppedAt !== null;
    if (verified || Date.now() >= deadline) return { reading, ack };
    await sleep(HALT_ACK_POLL_MS);
  }
}

export async function runSecurityHalt(
  argv: readonly string[],
  store: FileHaltStore,
  io: SecurityHaltIo,
  acks?: FileHaltAckStore,
): Promise<number> {
  const [command, ...rest] = argv;
  const now = io.now ?? (() => new Date());
  const readAck = async (): Promise<HaltAckReading> =>
    acks === undefined ? { kind: "none" } : acks.read();
  try {
    if (command === "status" && rest.length === 0) {
      io.out(describeHalt(await store.read(), await readAck()));
      return 0;
    }
    if (command === "halt" && rest.length === 1) {
      await store.halt(rest[0] ?? "", now());
      if (acks === undefined) {
        io.out(describeHalt(await store.read()));
        return 0;
      }
      const { reading, ack } = await waitForVerifiedStop(store, acks, io.sleep ?? delay);
      io.out(describeHalt(reading, ack));
      return 0;
    }
    if (command === "resume" && rest.length === 1) {
      await store.resume(rest[0] ?? "", now());
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
  const acks = new FileHaltAckStore(jarvisDataFile(HALT_ACK_FILE_BASENAME));
  return runSecurityHalt(
    process.argv.slice(2),
    store,
    {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    },
    acks,
  );
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
