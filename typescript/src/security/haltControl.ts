import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/**
 * `nolan sec halt` (#839, phase 3): an owner-written halt record that blocks
 * new governed dispatch. The record lives in one small JSON file so a separate
 * process (the owner's terminal) can halt a running service without a restart
 * or an authenticated API call.
 *
 * Fail closed: a missing file means "not halted"; any other read problem
 * (permissions, a symlink, invalid JSON, an unknown shape, an oversized file)
 * means "halted". This module only records and reads intent; the service's
 * HaltSupervisor (haltSupervisor.ts) cancels in-flight work and writes the
 * acknowledged and verified-stopped states.
 */

export const HALT_FILE_BASENAME = "jarvis-security-halt.json";
const MAX_HALT_FILE_BYTES = 4096;
const MAX_REASON_LENGTH = 280;

export type HaltRecordState = "none" | "requested";

const haltRecordSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["none", "requested"]),
    changedAt: z.string().datetime(),
    changedBy: z.literal("owner-cli"),
    reason: z.string().max(MAX_REASON_LENGTH),
  })
  .strict();

export type HaltRecord = z.infer<typeof haltRecordSchema>;

export type HaltReading =
  | { halted: false; record: HaltRecord | null }
  | {
      halted: true;
      record: HaltRecord | null;
      failClosed?: string;
      /**
       * Identifies this particular fail-closed condition (the file's inode,
       * times and size), so an acknowledgement of an earlier unreadable
       * record never counts for a later one.
       */
      failClosedRef?: string;
    };

export function normalizeHaltReason(reason: string): string {
  // Collapse control characters so the record stays one line in a terminal.
  // eslint-disable-next-line no-control-regex
  const cleaned = reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (cleaned.length === 0) throw new Error("A halt reason is required.");
  if (cleaned.length > MAX_REASON_LENGTH) {
    throw new Error(`A halt reason must be at most ${MAX_REASON_LENGTH} characters.`);
  }
  return cleaned;
}

export class FileHaltStore {
  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) throw new Error("Halt file path must be absolute.");
  }

  get path(): string {
    return this.filePath;
  }

  async read(): Promise<HaltReading> {
    const file = await readBoundedJsonFile(this.filePath);
    if (file.kind === "missing") return { halted: false, record: null };
    if (file.kind === "unreadable") {
      return failClosed(`halt record ${file.problem}`, await this.failClosedRef());
    }
    const parsed = haltRecordSchema.safeParse(file.value);
    if (!parsed.success) {
      return failClosed("halt record has an unknown shape", await this.failClosedRef());
    }
    return parsed.data.state === "none"
      ? { halted: false, record: parsed.data }
      : { halted: true, record: parsed.data };
  }

  /**
   * Any rewrite, replacement or chmod of the file changes its inode or ctime,
   * so this identifies one fail-closed condition. Undefined when the path
   * cannot even be stat'ed: that halt can then never be acknowledged.
   */
  private async failClosedRef(): Promise<string | undefined> {
    try {
      const info = await lstat(this.filePath, { bigint: true });
      return `fail-closed:${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
    } catch {
      return undefined;
    }
  }

  async halt(reason: string, now: Date = new Date()): Promise<HaltRecord> {
    return this.write({
      version: 1,
      state: "requested",
      changedAt: now.toISOString(),
      changedBy: "owner-cli",
      reason: normalizeHaltReason(reason),
    });
  }

  async resume(reason: string, now: Date = new Date()): Promise<HaltRecord> {
    return this.write({
      version: 1,
      state: "none",
      changedAt: now.toISOString(),
      changedBy: "owner-cli",
      reason: normalizeHaltReason(reason),
    });
  }

  private async write(record: HaltRecord): Promise<HaltRecord> {
    const validated = haltRecordSchema.parse(record);
    await writePrivateJsonAtomic(this.filePath, validated);
    return validated;
  }
}

export type BoundedJsonFile =
  { kind: "missing" } | { kind: "unreadable"; problem: string } | { kind: "ok"; value: unknown };

/**
 * Reads a small owner-private JSON file without following symlinks or
 * blocking on a FIFO. Only ENOENT reads as missing; every other problem is
 * reported so the caller can fail closed.
 */
export async function readBoundedJsonFile(filePath: string): Promise<BoundedJsonFile> {
  let raw: string;
  try {
    // O_NOFOLLOW: a symlinked file is refused. O_NONBLOCK: opening a FIFO
    // with no writer returns at once instead of hanging the caller; the
    // regular-file check below then refuses it.
    const handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { kind: "unreadable", problem: "is not a regular file" };
      if (stat.size > MAX_HALT_FILE_BYTES) return { kind: "unreadable", problem: "is too large" };
      raw = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (isErrno(error) && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", problem: "could not be read" };
  }
  if (Buffer.byteLength(raw) > MAX_HALT_FILE_BYTES) {
    return { kind: "unreadable", problem: "is too large" };
  }
  try {
    return { kind: "ok", value: JSON.parse(raw) as unknown };
  } catch {
    return { kind: "unreadable", problem: "is not valid JSON" };
  }
}

/** Atomically replaces `filePath` with owner-only (0600) JSON. */
export async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
  } catch (error: unknown) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, filePath);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Gate consumed by ToolExecutionService: true means refuse new dispatch. */
export type ExecutionHaltGate = () => Promise<boolean>;

export function haltGateFromStore(store: FileHaltStore): ExecutionHaltGate {
  return async () => {
    try {
      return (await store.read()).halted;
    } catch {
      return true;
    }
  };
}

function failClosed(reason: string, failClosedRef: string | undefined): HaltReading {
  return {
    halted: true,
    record: null,
    failClosed: reason,
    ...(failClosedRef === undefined ? {} : { failClosedRef }),
  };
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
