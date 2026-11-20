import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
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
 * means "halted". This module only records and reads intent. It does not
 * cancel in-flight work, so it never reports `verified_stopped`.
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
  | { halted: true; record: HaltRecord | null; failClosed?: string };

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
    let raw: string;
    try {
      // O_NOFOLLOW: a symlinked halt file is refused (and so reads as halted).
      // O_NONBLOCK: opening a FIFO with no writer returns at once instead of
      // hanging the dispatch gate; the regular-file check below then refuses it.
      const handle = await open(
        this.filePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return failClosed("halt record is not a regular file");
        if (stat.size > MAX_HALT_FILE_BYTES) return failClosed("halt record is too large");
        raw = await handle.readFile({ encoding: "utf8" });
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if (isErrno(error) && error.code === "ENOENT") return { halted: false, record: null };
      return failClosed("halt record could not be read");
    }
    if (Buffer.byteLength(raw) > MAX_HALT_FILE_BYTES) return failClosed("halt record is too large");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return failClosed("halt record is not valid JSON");
    }
    const parsed = haltRecordSchema.safeParse(value);
    if (!parsed.success) return failClosed("halt record has an unknown shape");
    return parsed.data.state === "none"
      ? { halted: false, record: parsed.data }
      : { halted: true, record: parsed.data };
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
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    const handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8" });
      await handle.sync();
    } catch (error: unknown) {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, this.filePath);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return validated;
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

function failClosed(reason: string): HaltReading {
  return { halted: true, record: null, failClosed: reason };
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
