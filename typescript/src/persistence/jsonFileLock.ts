import { createHash, randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
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
      rawDigest: string;
    };

type ReclaimClaimState =
  | { kind: "valid"; generation: number; record: LockRecord }
  | { kind: "malformed"; generation: number };

type ReclaimClaim = {
  path: string;
  identity: string;
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

function stateIdentity(state: Exclude<LockState, { kind: "missing" }>): string {
  const hash = createHash("sha256");
  if (state.kind === "valid") {
    hash.update("valid\0");
    hash.update(state.record.token);
  } else {
    hash.update("malformed\0");
    hash.update(String(state.device));
    hash.update("\0");
    hash.update(String(state.inode));
    hash.update("\0");
    hash.update(String(state.modifiedAt));
    hash.update("\0");
    hash.update(String(state.size));
    hash.update("\0");
    hash.update(state.rawDigest);
  }
  return hash.digest("hex");
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
      rawDigest: createHash("sha256").update(raw).digest("hex"),
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

  private reclaimClaimPrefix(identity: string): string {
    return `${path.basename(this.lockPath)}.reclaim-${identity}-`;
  }

  private async readLatestReclaimClaim(identity: string): Promise<ReclaimClaimState | null> {
    const directory = path.dirname(this.lockPath);
    const prefix = this.reclaimClaimPrefix(identity);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }

    const candidates = names
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, generation: Number(name.slice(prefix.length)) }))
      .filter(
        (entry) =>
          Number.isSafeInteger(entry.generation) &&
          entry.generation >= 0 &&
          String(entry.generation) === entry.name.slice(prefix.length),
      )
      .sort((a, b) => b.generation - a.generation);

    for (const candidate of candidates) {
      const claimPath = path.join(directory, candidate.name);
      let raw: string;
      try {
        raw = await fs.readFile(claimPath, "utf8");
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }

      try {
        const record = normalizeLockRecord(JSON.parse(raw) as unknown);
        if (record) {
          return { kind: "valid", generation: candidate.generation, record };
        }
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
      }

      return {
        kind: "malformed",
        generation: candidate.generation,
      };
    }

    return null;
  }

  private async claimReclamation(
    state: Exclude<LockState, { kind: "missing" }>,
  ): Promise<ReclaimClaim | null> {
    const identity = stateIdentity(state);
    const latest = await this.readLatestReclaimClaim(identity);

    if (latest?.kind === "valid" && isProcessAlive(latest.record.pid)) return null;
    // Age cannot prove that an unknown claim owner is dead. A paused live
    // writer and a crashed writer are indistinguishable here.
    if (latest?.kind === "malformed") return null;

    const generation = (latest?.generation ?? -1) + 1;
    const claimPath = path.join(
      path.dirname(this.lockPath),
      `${this.reclaimClaimPrefix(identity)}${generation}`,
    );
    const record: LockRecord = {
      pid: process.pid,
      acquiredAt: Date.now(),
      token: randomUUID(),
    };

    const tempPath = `${claimPath}.tmp-${process.pid}-${record.token}`;
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        // Election sees either no claim or the complete immutable owner record.
        await fs.link(tempPath, claimPath);
        return { path: claimPath, identity };
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === "EEXIST") return null;
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async reclaimStale(): Promise<boolean> {
    const state = await this.readState();
    if (state.kind === "missing") return true;

    const malformedGraceMs = Math.max(100, this.timeoutMs);
    if (state.kind === "valid") {
      if (isProcessAlive(state.record.pid)) return false;
    } else if (Date.now() - state.modifiedAt < malformedGraceMs) {
      return false;
    }

    const claim = await this.claimReclamation(state);
    if (!claim) return false;

    let releaseClaim = false;
    try {
      const confirmed = await this.readState();
      if (confirmed.kind === "missing") {
        releaseClaim = true;
        return true;
      }
      if (stateIdentity(confirmed) !== claim.identity) {
        releaseClaim = true;
        return false;
      }

      if (confirmed.kind === "valid") {
        if (isProcessAlive(confirmed.record.pid)) return false;
      } else if (Date.now() - confirmed.modifiedAt < malformedGraceMs) {
        return false;
      }

      try {
        await fs.rm(this.lockPath);
        releaseClaim = true;
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === "ENOENT") {
          releaseClaim = true;
          return true;
        }
        throw error;
      }

      if (confirmed.kind === "valid") {
        this.warn(
          `Jarvis reclaimed a stale JSON state lock left by process ${confirmed.record.pid}.`,
        );
      } else {
        this.warn("Jarvis reclaimed a stale malformed JSON state lock.");
      }
      return true;
    } finally {
      // If unlink failed, retain this generation: dropping it could let a
      // delayed reader elect another owner from a recycled claim pathname.
      if (releaseClaim) await fs.rm(claim.path, { force: true }).catch(() => undefined);
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

      if (Date.now() - startedAt >= Math.max(0, this.timeoutMs)) {
        const state = await this.readState();
        if (state.kind === "missing") continue;
        const owner =
          state.kind === "valid" ? `process ${state.record.pid}` : "a malformed lock file";
        throw new Error(
          `Jarvis JSON state is locked by ${owner}. Close the other local writer or select Convex for multi-process use.`,
        );
      }

      if (await this.reclaimStale()) continue;

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
