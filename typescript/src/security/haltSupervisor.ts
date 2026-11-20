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
 * The acknowledgement covers governed tool executions in the one process that
 * runs the supervisor (the HTTP service). It says nothing about other
 * processes or about non-tool background loops.
 */

export const HALT_ACK_FILE_BASENAME = "jarvis-security-halt-ack.json";
export const HALT_SUPERVISOR_INTERVAL_MS = 1_000;
/** Matches the halt record of a fail-closed (unreadable) halt. */
export const FAIL_CLOSED_HALT_REF = "fail-closed";

const haltAckSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal("governed-tool-executions"),
    haltRef: z.string().min(1).max(64),
    pid: z.number().int().positive(),
    acknowledgedAt: z.string().datetime(),
    cancelledExecutions: z.number().int().nonnegative(),
    unsettledExecutions: z.number().int().nonnegative(),
    verifiedStoppedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type HaltAck = z.infer<typeof haltAckSchema>;

export type HaltAckReading =
  { kind: "none" } | { kind: "unreadable"; problem: string } | { kind: "ack"; ack: HaltAck };

/** The acknowledgement reference that a halt reading must match. */
export function haltRefFor(reading: HaltReading): string | undefined {
  if (!reading.halted) return undefined;
  return reading.record?.changedAt ?? FAIL_CLOSED_HALT_REF;
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

type HaltSupervisorOptions = {
  intervalMs?: number;
  now?: () => Date;
  pid?: number;
  onError?: (error: unknown) => void;
};

export class HaltSupervisor {
  private current: HaltAck | undefined;
  private written: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;

  constructor(
    private readonly halts: FileHaltStore,
    private readonly acks: FileHaltAckStore,
    private readonly running: RunningExecutionRegistry,
    private readonly options: HaltSupervisorOptions = {},
  ) {}

  /** One poll: cancel while halted, then write the acknowledgement if it changed. */
  async tick(): Promise<void> {
    const reading = await this.halts.read();
    const haltRef = haltRefFor(reading);
    if (haltRef === undefined) {
      this.current = undefined;
      return;
    }
    // Every tick while halted, not only the first: an execution that started
    // in a process-local race, or in a service built without the halt gate,
    // is still cancelled.
    const cancelled = this.running.cancelAll();
    const unsettled = this.running.unsettled();
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const previous = this.current?.haltRef === haltRef ? this.current : undefined;
    const next: HaltAck = {
      version: 1,
      scope: "governed-tool-executions",
      haltRef,
      pid: this.options.pid ?? process.pid,
      acknowledgedAt: previous?.acknowledgedAt ?? now,
      cancelledExecutions: (previous?.cancelledExecutions ?? 0) + cancelled,
      unsettledExecutions: unsettled,
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
