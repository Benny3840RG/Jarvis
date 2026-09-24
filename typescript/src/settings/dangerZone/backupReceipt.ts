import fs from "node:fs/promises";
import path from "node:path";

import { writePrivateJsonFile } from "../../persistence/atomicJsonFile.js";
import { VERIFY_MAX_AGE_MS, type VerifiedBackup } from "./catalog.js";
import { DangerZoneRefusal, nodeErrorCode } from "./errors.js";

const RECEIPT_KIND = "jarvis-backup-verify-receipt";
const MAX_RECEIPT_BYTES = 4096;

export type BackupVerifyReceipt = {
  kind: typeof RECEIPT_KIND;
  archivePath: string;
  verifiedAt: string;
};

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function overlapsLiveDataDir(candidate: string, dataDir: string): boolean {
  const archive = path.resolve(candidate);
  const live = path.resolve(dataDir);
  return isInside(live, archive) || isInside(archive, live);
}

export async function writeBackupVerifyReceipt(
  archivePath: string,
  verifiedAt: Date,
): Promise<string> {
  const absolute = path.resolve(archivePath);
  const receiptPath = `${absolute}.jarvis-verify.json`;
  const receipt: BackupVerifyReceipt = {
    kind: RECEIPT_KIND,
    archivePath: absolute,
    verifiedAt: verifiedAt.toISOString(),
  };
  await writePrivateJsonFile(receiptPath, receipt);
  return receiptPath;
}

function parseReceipt(raw: string, receiptPath: string): BackupVerifyReceipt | null {
  if (Buffer.byteLength(raw) > MAX_RECEIPT_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== RECEIPT_KIND) return null;
  if (typeof record.archivePath !== "string" || record.archivePath.length === 0) return null;
  if (typeof record.verifiedAt !== "string" || Number.isNaN(Date.parse(record.verifiedAt))) {
    return null;
  }
  const expectedArchive = receiptPath.slice(0, -".jarvis-verify.json".length);
  if (path.resolve(record.archivePath) !== path.resolve(expectedArchive)) return null;
  return {
    kind: RECEIPT_KIND,
    archivePath: path.resolve(record.archivePath),
    verifiedAt: new Date(record.verifiedAt).toISOString(),
  };
}

async function readReceipt(receiptPath: string): Promise<BackupVerifyReceipt | null> {
  const entry = await fs.lstat(receiptPath).catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (entry === null || entry.isSymbolicLink() || !entry.isFile()) return null;
  if (entry.size > MAX_RECEIPT_BYTES) return null;
  const raw = await fs.readFile(receiptPath, "utf8");
  return parseReceipt(raw, receiptPath);
}

async function listRecentVerifiedBackups(options: {
  directories: readonly string[];
  dataDir: string;
  now: Date;
  maxAgeMs?: number;
}): Promise<VerifiedBackup[]> {
  const maxAgeMs = options.maxAgeMs ?? VERIFY_MAX_AGE_MS;
  const found: VerifiedBackup[] = [];
  for (const directory of options.directories) {
    const names = await fs.readdir(directory).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT" || nodeErrorCode(error) === "ENOTDIR") return [];
      throw error;
    });
    for (const name of names) {
      if (!name.endsWith(".jarvis-verify.json")) continue;
      const receipt = await readReceipt(path.join(directory, name));
      if (receipt === null) continue;
      if (overlapsLiveDataDir(receipt.archivePath, options.dataDir)) continue;
      const verifiedAtMs = Date.parse(receipt.verifiedAt);
      const age = options.now.getTime() - verifiedAtMs;
      if (age < 0 || age > maxAgeMs) continue;
      const exists = await fs.lstat(receipt.archivePath).catch((error: unknown) => {
        if (nodeErrorCode(error) === "ENOENT") return null;
        throw error;
      });
      if (exists === null || exists.isSymbolicLink() || !exists.isFile()) continue;
      found.push({ path: receipt.archivePath, verifiedAt: receipt.verifiedAt });
    }
  }
  return found;
}

export async function findRecentVerifiedBackup(options: {
  directories: readonly string[];
  dataDir: string;
  now: Date;
  maxAgeMs?: number;
}): Promise<VerifiedBackup | null> {
  const found = await listRecentVerifiedBackups(options);
  return found.reduce<VerifiedBackup | null>(
    (best, candidate) =>
      best === null || candidate.verifiedAt > best.verifiedAt ? candidate : best,
    null,
  );
}

export async function assertVerifiedBackup(options: {
  requestedPath: string;
  directories: readonly string[];
  dataDir: string;
  now: Date;
  maxAgeMs?: number;
}): Promise<VerifiedBackup> {
  const requested = path.resolve(options.requestedPath);
  if (overlapsLiveDataDir(requested, options.dataDir)) {
    throw new DangerZoneRefusal(
      "path",
      `Refusing backup path ${requested}: it overlaps the live Jarvis data directory ${path.resolve(options.dataDir)}.`,
    );
  }
  const recent = (await listRecentVerifiedBackups(options)).find(
    (candidate) => path.resolve(candidate.path) === requested,
  );
  if (recent === undefined) {
    throw new DangerZoneRefusal(
      "backup",
      "No verified backup from the last 24 hours matches that path. Verify one with npm run backup -- verify, or explicitly skip the backup.",
    );
  }
  return recent;
}
