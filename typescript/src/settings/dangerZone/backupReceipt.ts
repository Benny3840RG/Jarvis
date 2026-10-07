import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { writePrivateJsonFile } from "../../persistence/atomicJsonFile.js";
import { businessDataFiles } from "../../persistence/jarvisDataPaths.js";
import { VERIFY_MAX_AGE_MS, type VerifiedBackup } from "./catalog.js";
import { DangerZoneRefusal, nodeErrorCode } from "./errors.js";

const RECEIPT_KIND = "jarvis-backup-verify-receipt";
const MAX_RECEIPT_BYTES = 4096;
const CHECKSUM_VALUE = /^(?:absent|[0-9a-f]{64})$/;

/** Business JSON basenames `clear-local` quarantines. A classic receipt must name each one. */
export const BUSINESS_CLEAR_BASENAMES = Object.values(businessDataFiles).map((filePath) =>
  path.basename(filePath),
);

export type BackupVerifyReceipt = {
  kind: typeof RECEIPT_KIND;
  archivePath: string;
  verifiedAt: string;
  businessChecksums?: Readonly<Record<string, string>>;
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

export async function businessFileChecksums(dataDir: string): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  for (const basename of BUSINESS_CLEAR_BASENAMES) {
    const filePath = path.join(dataDir, basename);
    const entry = await fs.lstat(filePath).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (entry === null) {
      checksums[basename] = "absent";
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new DangerZoneRefusal(
        "backup",
        `Refusing to checksum ${filePath}: business files must be regular files.`,
      );
    }
    checksums[basename] = createHash("sha256")
      .update(await fs.readFile(filePath))
      .digest("hex");
  }
  return checksums;
}

function checksumMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const expected = [...BUSINESS_CLEAR_BASENAMES].sort();
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return undefined;
  }
  const checksums: Record<string, string> = {};
  for (const key of expected) {
    const digest = record[key];
    if (typeof digest !== "string" || !CHECKSUM_VALUE.test(digest)) return undefined;
    checksums[key] = digest;
  }
  return checksums;
}

export async function writeBackupVerifyReceipt(
  archivePath: string,
  verifiedAt: Date,
  businessChecksums?: Readonly<Record<string, string>>,
): Promise<string> {
  const absolute = path.resolve(archivePath);
  const receiptPath = `${absolute}.jarvis-verify.json`;
  const checksums = businessChecksums === undefined ? undefined : checksumMap(businessChecksums);
  if (businessChecksums !== undefined && checksums === undefined) {
    throw new DangerZoneRefusal(
      "backup",
      "A clear-local receipt must list sha256 or absent for every business JSON file.",
    );
  }
  const receipt: BackupVerifyReceipt = {
    kind: RECEIPT_KIND,
    archivePath: absolute,
    verifiedAt: verifiedAt.toISOString(),
    ...(checksums === undefined ? {} : { businessChecksums: checksums }),
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
  const businessChecksums =
    "businessChecksums" in record ? checksumMap(record.businessChecksums) : undefined;
  if ("businessChecksums" in record && businessChecksums === undefined) return null;
  return {
    kind: RECEIPT_KIND,
    archivePath: path.resolve(record.archivePath),
    verifiedAt: new Date(record.verifiedAt).toISOString(),
    ...(businessChecksums === undefined ? {} : { businessChecksums }),
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

/**
 * `clear-local` quarantines business JSON. A classic verify receipt does not
 * list those files, so it cannot authorise that rename.
 */
export async function assertBusinessChecksumsForClear(options: {
  archivePath: string;
  dataDir: string;
}): Promise<void> {
  const receipt = await readReceipt(`${path.resolve(options.archivePath)}.jarvis-verify.json`);
  if (receipt?.businessChecksums === undefined) {
    throw new DangerZoneRefusal(
      "backup",
      "A classic verify receipt does not list business file checksums, so it cannot authorise quarantining them.",
    );
  }
  const current = await businessFileChecksums(options.dataDir);
  for (const basename of BUSINESS_CLEAR_BASENAMES) {
    if (receipt.businessChecksums[basename] !== current[basename]) {
      throw new DangerZoneRefusal(
        "backup",
        `Verified backup checksum for ${basename} does not match the live business file. Nothing was quarantined.`,
      );
    }
  }
}
