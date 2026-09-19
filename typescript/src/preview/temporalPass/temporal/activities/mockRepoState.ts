import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJsonFile } from "../../../../persistence/atomicJsonFile.js";
import { JsonFileLock } from "../../../../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../../../../persistence/types.js";

export interface MockRepoState {
  currentSha: string;
  branchProtectionSatisfied: boolean;
  isMerged: boolean;
  mergedSha?: string;
  /**
   * Counters for tests that need to distinguish "the Activity function ran
   * N times" from "the external effect happened once" (PASS-13) — the two
   * are not the same thing under at-least-once execution, and a final-state
   * assertion like `mergedSha === expectedSha` can't tell them apart on its
   * own (two idempotent duplicate merges of the same SHA land on identical
   * final state).
   */
  mergeAttemptCount: number;
  mergeEffectCount: number;
}

type Store = Record<string, MockRepoState>;

function defaultDataPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(
    path.dirname(filename),
    "../../../../../data/preview/temporal-pass-mock-repo.json",
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function seedState(repo: string): MockRepoState {
  return {
    currentSha: `seed-${repo}`,
    branchProtectionSatisfied: true,
    isMerged: false,
    mergeAttemptCount: 0,
    mergeEffectCount: 0,
  };
}

/**
 * Stands in for "GitHub" in Phase 1. File-backed (not an in-memory Map) so
 * that a worker-process restart (PASS-01) or a full server+worker restart
 * (PASS-02/PASS-03) doesn't spuriously reset the external system's state —
 * a real GitHub repo's state doesn't depend on whether Jarvis's worker is
 * currently running.
 *
 * SINGLE HOST ONLY (see README.md "Persistence scope") — same caveat as
 * `idempotency/idempotencyStore.ts`.
 */
export class MockRepoStateStore {
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

  async get(repo: string): Promise<MockRepoState> {
    const store = await this.readStore();
    return store[repo] ?? seedState(repo);
  }

  /** Atomic read-modify-write, for tests that need to inject a state change (e.g. a SHA race). */
  async update(
    repo: string,
    mutate: (state: MockRepoState) => MockRepoState,
  ): Promise<MockRepoState> {
    return this.lock.run(async () => {
      const store = await this.readStore();
      const next = mutate(store[repo] ?? seedState(repo));
      store[repo] = next;
      await writePrivateJsonFile(this.filePath, store);
      return next;
    }, `mock repo state write for ${repo}`);
  }
}
