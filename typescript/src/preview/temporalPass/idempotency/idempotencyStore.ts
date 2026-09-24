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

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function parseStore(raw: string): Store {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("idempotency store root must be an object");
  }

  for (const [key, entry] of Object.entries(value)) {
    if (!key || entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`invalid idempotency entry for ${JSON.stringify(key)}`);
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.some(
        (field) => !["operation", "state", "result", "createdAt", "completedAt"].includes(field),
      ) ||
      typeof record.operation !== "string" ||
      record.operation.length === 0 ||
      !["pending", "completed", "failed"].includes(String(record.state)) ||
      !isTimestamp(record.createdAt) ||
      (record.completedAt !== undefined && !isTimestamp(record.completedAt))
    ) {
      throw new Error(`invalid idempotency entry for ${JSON.stringify(key)}`);
    }
  }

  return value as Store;
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
      return parseStore(raw);
    } catch (error: unknown) {
      // Unlike a missing file (a legitimate "no store yet" state), a file
      // that exists but fails to parse is corruption — silently treating it
      // as empty would discard every completed entry and let already
      // -executed external effects (a merge, a notification) run again.
      // Fail loud instead.
      throw new Error(
        `Jarvis idempotency store at ${this.filePath} is corrupted and could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
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
   * Skips re-running `execute` for a `key` that already has a completed
   * entry — the common case across sequential Activity retries and process
   * restarts (Temporal never dispatches a second attempt for the same
   * Activity task while a prior attempt is still live; a retry only
   * happens after the prior one is confirmed dead/failed).
   *
   * This is **not** an atomic compare-and-swap: the check and the
   * eventual `set()` are two separate operations with `execute()` running
   * in between, unguarded by `lock`. Two genuinely concurrent callers for
   * the same key (e.g. a "zombie" worker that missed its heartbeat timeout
   * but is still actually running, racing the new worker Temporal
   * rescheduled to) could both see "not completed" and both run
   * `execute()`. For that reason `execute()` itself must reconcile against
   * real external state first (e.g. "is this PR already merged?") rather
   * than trusting a cache hit here alone — see `mergePR` in
   * `mockPassActivities.ts` for the pattern, and PASS-13 for a test that
   * measures the external effect count directly rather than just the
   * final state, since two idempotent-but-duplicate executions can land on
   * the same final state without proving only one of them ran.
   *
   * The narrower, *sequential* case — a worker dies after `execute()` has
   * already mutated external state but before `set()` records completion,
   * so the next attempt reruns `execute()` — is safe even for activities
   * like `executeBuild` that mint a fresh random value every call: the
   * abandoned attempt's mutation is simply overwritten by the retry's, and
   * the retry's own return value is what both the caller and the external
   * state end up agreeing on. There's no window where a caller observes a
   * result that doesn't match what actually landed, because only one
   * attempt is ever live at a time in this case. PASS-01 exercises exactly
   * this path (a real process kill mid-`executeBuild`, then a fresh worker
   * retries) and asserts the final mock-repo state matches what the
   * idempotency store recorded — not just that *some* build happened.
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
