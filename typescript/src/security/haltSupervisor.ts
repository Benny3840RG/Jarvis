import path from "node:path";

import { z } from "zod";

import type { RunningExecutionRegistry } from "../actions/runningExecutions.js";
import {
  readBoundedJsonFile,
  writePrivateJsonAtomic,
  type FileHaltStore,
  type HaltReading,
} from "./haltControl.js";

/**
 * The service side of `nolan sec halt` (#839).
 *
 * The owner's CLI writes the halt record (`requested`). The running service
 * polls it; while halted, the supervisor cancels every registered governed
 * tool execution and writes an acknowledgement:
 *
 * - `acknowledged`: this service process saw this exact halt record and
 *   cancelled its running executions.
 * - `verified_stopped`: additionally, no execution in this process has an
 *   effect that may still be running. An effect that ignores its abort keeps
 *   this false until it settles.
 *
 * The acknowledgement covers governed tool executions and each registered
 * service-controlled runtime in the one process that runs the supervisor (the
 * HTTP service). It says nothing about other processes or unregistered loops.
 */

export const HALT_ACK_FILE_BASENAME = "jarvis-security-halt-ack.json";
export const HALT_SUPERVISOR_INTERVAL_MS = 1_000;
const haltAckSchema = z
  .object({
    // Version 2 expands the acknowledgement from governed tool executions to
    // every service-controlled runtime registered with the supervisor. A v1
    // file is deliberately unreadable after upgrade, so it can never claim a
    // verified stop before the newly managed runtime has stopped.
    version: z.literal(2),
    scope: z.literal("service-controlled-work"),
    haltRef: z.string().min(1).max(200),
    pid: z.number().int().positive(),
    acknowledgedAt: z.string().datetime(),
    cancelledExecutions: z.number().int().nonnegative(),
    unsettledExecutions: z.number().int().nonnegative(),
    stoppedRuntimes: z.number().int().nonnegative(),
    verifiedStoppedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type HaltAck = z.infer<typeof haltAckSchema>;

export type HaltAckReading =
  { kind: "none" } | { kind: "unreadable"; problem: string } | { kind: "ack"; ack: HaltAck };

/**
 * The acknowledgement reference that a halt reading must match: the record's
 * unique `id` (`changedAt` for a record written before ids existed), or the
 * identity of one particular unreadable file. Undefined
 * when not halted, or when a fail-closed halt cannot be identified (that halt
 * is still enforced and cancelled, but never reported as acknowledged).
 */
export function haltRefFor(reading: HaltReading): string | undefined {
  if (!reading.halted) return undefined;
  if (reading.record === null) return reading.failClosedRef;
  return reading.record.id === undefined
    ? `record:${reading.record.changedAt}`
    : `record:${reading.record.id}`;
}

/**
 * The halt as a read model for `GET /api/v1/status`. It carries no reason
 * text: the owner's words stay in the owner-private files and the CLI.
 */
export type SecurityHaltStatus = {
  state: "running" | "requested" | "acknowledged" | "verified-stopped" | "unverifiable";
  dispatch: "allowed" | "refused";
  failClosed: boolean;
  requestedAt: string | null;
  acknowledgedAt: string | null;
  verifiedStoppedAt: string | null;
  unsettledExecutions: number | null;
};

/**
 * One derivation for every reader. An acknowledgement counts only when it is
 * bound to this exact halt (`haltRefFor`); an unreadable acknowledgement
 * counts as none, so it can never produce a verified stop.
 */
export function summarizeSecurityHalt(
  reading: HaltReading,
  ackReading: HaltAckReading,
): SecurityHaltStatus {
  if (!reading.halted) {
    return {
      state: "running",
      dispatch: "allowed",
      failClosed: false,
      requestedAt: null,
      acknowledgedAt: null,
      verifiedStoppedAt: null,
      unsettledExecutions: null,
    };
  }
  const base = {
    dispatch: "refused" as const,
    failClosed: reading.record === null,
    requestedAt: reading.record?.changedAt ?? null,
  };
  const haltRef = haltRefFor(reading);
  if (haltRef === undefined) {
    return {
      ...base,
      state: "unverifiable",
      acknowledgedAt: null,
      verifiedStoppedAt: null,
      unsettledExecutions: null,
    };
  }
  const ack = ackReading.kind === "ack" ? ackReading.ack : undefined;
  if (ack === undefined || ack.haltRef !== haltRef) {
    return {
      ...base,
      state: "requested",
      acknowledgedAt: null,
      verifiedStoppedAt: null,
      unsettledExecutions: null,
    };
  }
  return {
    ...base,
    state: ack.verifiedStoppedAt === null ? "acknowledged" : "verified-stopped",
    acknowledgedAt: ack.acknowledgedAt,
    verifiedStoppedAt: ack.verifiedStoppedAt,
    unsettledExecutions: ack.unsettledExecutions,
  };
}

/** The status the service reports when the halt files cannot be read at all. */
export const UNREADABLE_SECURITY_HALT_STATUS: SecurityHaltStatus = Object.freeze({
  state: "unverifiable",
  dispatch: "refused",
  failClosed: true,
  requestedAt: null,
  acknowledgedAt: null,
  verifiedStoppedAt: null,
  unsettledExecutions: null,
});

export function securityHaltStatusReader(
  halts: FileHaltStore,
  acks: FileHaltAckStore,
): () => Promise<SecurityHaltStatus> {
  return async () => {
    try {
      return summarizeSecurityHalt(await halts.read(), await acks.read());
    } catch {
      return { ...UNREADABLE_SECURITY_HALT_STATUS };
    }
  };
}

export class FileHaltAckStore {
  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) throw new Error("Halt acknowledgement path must be absolute.");
  }

  async read(): Promise<HaltAckReading> {
    const file = await readBoundedJsonFile(this.filePath);
    if (file.kind === "missing") return { kind: "none" };
    if (file.kind === "unreadable") return { kind: "unreadable", problem: file.problem };
    const parsed = haltAckSchema.safeParse(file.value);
    if (!parsed.success) return { kind: "unreadable", problem: "has an unknown shape" };
    return { kind: "ack", ack: parsed.data };
  }

  async write(ack: HaltAck): Promise<void> {
    await writePrivateJsonAtomic(this.filePath, haltAckSchema.parse(ack));
  }
}

export type HaltManagedRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

type HaltSupervisorOptions = {
  intervalMs?: number;
  now?: () => Date;
  pid?: number;
  onError?: (error: unknown) => void;
  managedRuntimes?: readonly HaltManagedRuntime[];
};

export class HaltSupervisor {
  private current: HaltAck | undefined;
  private written: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private managedRuntimesInitialized = false;
  private managedRuntimesStopped = false;

  constructor(
    private readonly halts: FileHaltStore,
    private readonly acks: FileHaltAckStore,
    private readonly running: RunningExecutionRegistry,
    private readonly options: HaltSupervisorOptions = {},
  ) {}

  /** One poll: cancel while halted, then write the acknowledgement if it changed. */
  async tick(): Promise<void> {
    const reading = await this.halts.read();
    if (!reading.halted) {
      if (!this.managedRuntimesInitialized || this.managedRuntimesStopped) {
        // The supervisor owns initial start as well as resume. This closes the
        // startup race where a runtime could skip start for a halt that was
        // resumed before the supervisor observed it. A failed start leaves the
        // state unchanged, so the caller or the next tick can retry.
        for (const runtime of this.options.managedRuntimes ?? []) await runtime.start();
        this.managedRuntimesInitialized = true;
        this.managedRuntimesStopped = false;
      }
      this.current = undefined;
      return;
    }

    // Cancellation is synchronous and must not wait behind a runtime that is
    // slow to honour its abort. Acknowledgement still waits for every runtime
    // stop to succeed and for every governed effect to settle.
    const cancelled = this.running.cancelAll();

    // stop() is required to be idempotent and is called on every halted tick,
    // matching the execution cancellation race protection above.
    for (const runtime of this.options.managedRuntimes ?? []) await runtime.stop();
    this.managedRuntimesInitialized = true;
    this.managedRuntimesStopped = true;

    const unsettled = this.running.unsettled();
    const haltRef = haltRefFor(reading);
    if (haltRef === undefined) {
      this.current = undefined;
      return;
    }
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const previous = this.current?.haltRef === haltRef ? this.current : undefined;
    const next: HaltAck = {
      version: 2,
      scope: "service-controlled-work",
      haltRef,
      pid: this.options.pid ?? process.pid,
      acknowledgedAt: previous?.acknowledgedAt ?? now,
      cancelledExecutions: (previous?.cancelledExecutions ?? 0) + cancelled,
      unsettledExecutions: unsettled,
      stoppedRuntimes: (this.options.managedRuntimes ?? []).length,
      verifiedStoppedAt: unsettled === 0 ? (previous?.verifiedStoppedAt ?? now) : null,
      updatedAt: previous?.updatedAt ?? now,
    };
    this.current = next;
    const comparable = JSON.stringify({ ...next, updatedAt: undefined });
    if (comparable === this.written) return;
    next.updatedAt = now;
    await this.acks.write(next);
    this.written = comparable;
  }

  start(): void {
    if (this.timer !== undefined) return;
    const run = () => {
      if (this.ticking !== undefined) return;
      this.ticking = this.tick()
        .catch((error: unknown) => {
          // A failed write is retried next tick; the owner then sees
          // "not acknowledged", never a false verified stop.
          this.written = undefined;
          this.options.onError?.(error);
        })
        .finally(() => {
          this.ticking = undefined;
        });
    };
    run();
    this.timer = setInterval(run, this.options.intervalMs ?? HALT_SUPERVISOR_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
  }
}
