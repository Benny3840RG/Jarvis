import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJsonFile } from "../../../persistence/atomicJsonFile.js";
import { JsonFileLock } from "../../../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../../../persistence/types.js";

export interface IdempotencyEntry {
  operation: string;
  state: "pending" | "completed" | "failed";
  result?: unknown;
  createdAt: string;
  completedAt?: string;
}

type Store = Record<string, IdempotencyEntry>;

function defaultDataPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(
    path.dirname(filename),
    "../../../../data/preview/temporal-pass-idempotency.json",
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * File-backed idempotency store for the Temporal PASS prototype.
 *
 * Deliberately reuses the existing crash-safe atomic-write primitive
 * (`writePrivateJsonFile`: exclusive temp create, mode 0600, fsync before
 * rename) and the existing single-writer file lock (`JsonFileLock`) instead
 * of adding a new SQLite/Redis dependency — the whole point is that this
 * state must survive a real process/machine restart (PASS-02/PASS-03), not
 * just live in an in-memory Map.
 *
 * SINGLE HOST ONLY (see README.md "Persistence scope"): this is a local
 * file, correct for one worker on one host. It does not generalize to
 * multiple workers/hosts — that needs a shared store (e.g. Convex), not
 * this file, since two hosts would each hold their own disagreeing copy.
 */
export class IdempotencyStore {
  private readonly lock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultDataPath(),
    warn: PersistenceWarning = (message) => console.warn(message),
    lockTimeoutMs = 2_000,
  ) {
    this.lock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readStore(): Promise<Store> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return {};
      throw error;
    }
    try {
      return JSON.parse(raw) as Store;
    } catch {
      return {};
    }
  }

  async get(key: string): Promise<IdempotencyEntry | null> {
    const store = await this.readStore();
    return store[key] ?? null;
  }

  async set(key: string, entry: IdempotencyEntry): Promise<void> {
    await this.lock.run(async () => {
      const store = await this.readStore();
      store[key] = entry;
      await writePrivateJsonFile(this.filePath, store);
    }, `idempotency store write for ${key}`);
  }

  /**
   * Runs `execute` at most once per `key` across any number of retries,
   * process restarts, or Activity re-executions: if a completed entry
   * already exists it's returned without re-running `execute`. Callers
   * that need to reconcile against real external state first (e.g. "is
   * this PR already merged?") should do that before calling this, since a
   * cache hit here only proves *this store* has seen the operation before.
   */
  async runIdempotent<T>(key: string, operation: string, execute: () => Promise<T>): Promise<T> {
    const existing = await this.get(key);
    if (existing?.state === "completed") {
      return existing.result as T;
    }

    const result = await execute();

    await this.set(key, {
      operation,
      state: "completed",
      result,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    return result;
  }
}
