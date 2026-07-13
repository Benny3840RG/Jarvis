import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { PersistenceWarning } from "./types.js";

const LOCK_RETRY_MS = 25;

type LockRecord = {
  pid: number;
  acquiredAt: number;
  token: string;
};

type LockState =
  | { kind: "missing" }
  | { kind: "valid"; record: LockRecord }
  | {
      kind: "malformed";
      modifiedAt: number;
      size: number;
      device: number;
      inode: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function normalizeLockRecord(value: unknown): LockRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    return null;
  }
  if (typeof value.acquiredAt !== "number" || !Number.isFinite(value.acquiredAt)) return null;
  if (typeof value.token !== "string" || value.token.length === 0) return null;
  return {
    pid: value.pid,
    acquiredAt: value.acquiredAt,
    token: value.token,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    return true;
  }
}

export class JsonFileLock {
  private readonly lockPath: string;

  constructor(
    private readonly filePath: string,
    private readonly warn: PersistenceWarning,
    private readonly timeoutMs: number,
  ) {
    this.lockPath = `${filePath}.lock`;
  }

  private async readState(): Promise<LockState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.lockPath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
      throw error;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(this.lockPath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
      throw error;
    }

    try {
      const record = normalizeLockRecord(JSON.parse(raw) as unknown);
      if (record) return { kind: "valid", record };
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
    }

    return {
      kind: "malformed",
      modifiedAt: stat.mtimeMs,
      size: stat.size,
      device: stat.dev,
      inode: stat.ino,
    };
  }

  private async removeOwned(token: string): Promise<boolean> {
    const state = await this.readState();
    if (state.kind === "missing") return true;
    if (state.kind !== "valid" || state.record.token !== token) return false;
    try {
      await fs.rm(this.lockPath);
      return true;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
  }

  private async reclaimStale(): Promise<boolean> {
    const state = await this.readState();
    if (state.kind === "missing") return true;

    if (state.kind === "valid") {
      if (isProcessAlive(state.record.pid)) return false;
      if (!(await this.removeOwned(state.record.token))) return false;
      this.warn(`Jarvis reclaimed a stale JSON state lock left by process ${state.record.pid}.`);
      return true;
    }

    const malformedGraceMs = Math.max(100, this.timeoutMs);
    if (Date.now() - state.modifiedAt < malformedGraceMs) return false;

    const confirmed = await this.readState();
    if (
      confirmed.kind !== "malformed" ||
      confirmed.modifiedAt !== state.modifiedAt ||
      confirmed.size !== state.size ||
      confirmed.device !== state.device ||
      confirmed.inode !== state.inode
    ) {
      return confirmed.kind === "missing";
    }

    try {
      await fs.rm(this.lockPath);
      this.warn("Jarvis reclaimed a stale malformed JSON state lock.");
      return true;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
  }

  private async tryCreate(record: LockRecord): Promise<boolean> {
    const tempPath = `${this.lockPath}.tmp-${process.pid}-${record.token}`;
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await fs.link(tempPath, this.lockPath);
        return true;
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === "EEXIST") return false;
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async acquire(): Promise<LockRecord> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const startedAt = Date.now();
    const record: LockRecord = {
      pid: process.pid,
      acquiredAt: Date.now(),
      token: randomUUID(),
    };

    while (true) {
      if (await this.tryCreate(record)) return record;
      if (await this.reclaimStale()) continue;

      if (Date.now() - startedAt >= Math.max(0, this.timeoutMs)) {
        const state = await this.readState();
        if (state.kind === "missing") continue;
        const owner =
          state.kind === "valid" ? `process ${state.record.pid}` : "a malformed lock file";
        throw new Error(
          `Jarvis JSON state is locked by ${owner}. Close the other local writer or select Convex for multi-process use.`,
        );
      }

      await delay(LOCK_RETRY_MS);
    }
  }

  async run<T>(operation: () => Promise<T>, failureDescription = "backup operation"): Promise<T> {
    const lock = await this.acquire();
    let result: T | undefined;
    let failed = false;
    let primaryError: unknown;
    try {
      result = await operation();
    } catch (error: unknown) {
      failed = true;
      primaryError = error;
    }

    let releaseError: unknown;
    try {
      if (!(await this.removeOwned(lock.token))) {
        throw new Error(
          "Jarvis JSON state lock ownership changed before release; lock left in place.",
        );
      }
    } catch (error: unknown) {
      releaseError = error;
    }

    if (failed) {
      if (releaseError !== undefined) {
        throw new AggregateError(
          [primaryError, releaseError],
          `Jarvis JSON ${failureDescription} failed and its state lock could not be released safely.`,
        );
      }
      throw primaryError;
    }
    if (releaseError !== undefined) throw releaseError;
    return result as T;
  }
}
