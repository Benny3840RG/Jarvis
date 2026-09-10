import fs, { constants as fsConstants, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  ArchiveManifestError,
  buildManifest,
  groupChecksum,
  parseManifest,
  sortUnresolvedReferences,
  type ArchiveGroupEntry,
  type ArchiveManifest,
  type ArchiveUnresolvedReference,
} from "../archiveManifest.js";
import { StrictBackupError } from "../strictValues.js";
import { businessUnresolvedReferences, type BusinessRecordsPayload } from "./businessSource.js";
import { memoryUnresolvedReferences } from "./jsonSource.js";
import type { CoreGroupPayload, JsonCapture, MemoryGroupPayload } from "./jsonSource.js";

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;

/** Schema version of each group payload shape, independent of the contract version. */
export const CORE_GROUP_SCHEMA_VERSION = 1;
export const MEMORY_GROUP_SCHEMA_VERSION = 1;
export const BUSINESS_RECORDS_GROUP_SCHEMA_VERSION = 1;

export type ArchiveV4 = {
  manifest: ArchiveManifest;
  groups: {
    core?: CoreGroupPayload;
    memory?: MemoryGroupPayload;
    businessRecords?: BusinessRecordsPayload;
  };
};

/** Group names this stage knows how to carry a payload for. */
type PayloadGroup = keyof ArchiveV4["groups"];

function coreEntry(payload: CoreGroupPayload): ArchiveGroupEntry {
  return {
    group: "core",
    schemaVersion: CORE_GROUP_SCHEMA_VERSION,
    counts: {
      stateKeys: Object.keys(payload.state).length,
      tasks: payload.tasks.length,
      reminders: payload.reminders.length,
    },
    checksum: groupChecksum(payload),
    consistentSnapshot: true,
  };
}

function memoryEntry(payload: MemoryGroupPayload): ArchiveGroupEntry {
  return {
    group: "memory",
    schemaVersion: MEMORY_GROUP_SCHEMA_VERSION,
    counts: {
      builds: payload.builds.length,
      buildLogs: payload.buildLogs.length,
      upgrades: payload.upgrades.length,
      assets: payload.assets.length,
      preferences: payload.preferences.length,
    },
    checksum: groupChecksum(payload),
    consistentSnapshot: true,
  };
}

function businessRecordsEntry(payload: BusinessRecordsPayload): ArchiveGroupEntry {
  return {
    group: "businessRecords",
    schemaVersion: BUSINESS_RECORDS_GROUP_SCHEMA_VERSION,
    counts: {
      clients: payload.clients.length,
      properties: payload.properties.length,
      projects: payload.projects.length,
      quotes: payload.quotes.length,
      invoices: payload.invoices.length,
      enquiries: payload.enquiries.length,
      errands: payload.errands.length,
      // 0 distinguishes "settings have never been written, the runtime
      // synthesises defaults" from 1, "these exact settings were stored".
      businessSettings: payload.businessSettings === null ? 0 : 1,
    },
    checksum: groupChecksum(payload),
    consistentSnapshot: true,
  };
}

/**
 * Assembles a v4 archive from a JSON capture. Both groups are marked
 * `consistentSnapshot: true` because `captureJsonGroups` held every covered
 * file's lock for the whole read. Groups this stage does not implement are
 * simply absent, which makes the manifest `partial` — that is the honest state,
 * not an exclusion, so `exclusions` stays empty.
 */
export function buildArchiveV4(capture: JsonCapture, createdAt: Date): ArchiveV4 {
  return {
    manifest: buildManifest({
      createdAt,
      groups: [
        coreEntry(capture.core),
        memoryEntry(capture.memory),
        businessRecordsEntry(capture.businessRecords),
      ],
      unresolvedReferences: unresolvedReferencesFor(capture),
    }),
    groups: {
      core: capture.core,
      memory: capture.memory,
      businessRecords: capture.businessRecords,
    },
  };
}

/**
 * The single derivation of an archive's unresolved references, used both when
 * building a manifest and when re-deriving from restored data to check that the
 * manifest was not overstated or understated.
 */
export function unresolvedReferencesFor(groups: ArchiveV4["groups"]): ArchiveUnresolvedReference[] {
  return sortUnresolvedReferences([
    ...(groups.memory ? memoryUnresolvedReferences(groups.memory) : []),
    ...(groups.businessRecords ? businessUnresolvedReferences(groups.businessRecords) : []),
  ]);
}

function verifyChecksums(archive: ArchiveV4): void {
  for (const entry of archive.manifest.groups) {
    const payload = archive.groups[entry.group as PayloadGroup];
    if (payload === undefined) {
      throw new StrictBackupError(
        `Archive manifest lists group "${entry.group}" but the archive carries no payload for it.`,
      );
    }
    const actual = groupChecksum(payload);
    if (actual !== entry.checksum) {
      throw new StrictBackupError(
        `Archive group "${entry.group}" checksum mismatch: manifest says ${entry.checksum}, content hashes to ${actual}.`,
      );
    }
  }
  for (const present of Object.keys(archive.groups)) {
    if (!archive.manifest.groups.some((entry) => entry.group === present)) {
      throw new StrictBackupError(
        `Archive carries a payload for group "${present}" that its manifest does not list.`,
      );
    }
  }
}

/**
 * Strict archive parse: the manifest must be self-consistent (see
 * `parseManifest`), every listed group must have a payload, every payload must
 * be listed, and every group checksum must match its content.
 */
export function parseArchiveV4(value: unknown): ArchiveV4 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StrictBackupError("Archive must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "manifest" && key !== "groups") {
      throw new StrictBackupError(`Archive has an unsupported field "${key}".`);
    }
  }
  let manifest: ArchiveManifest;
  try {
    manifest = parseManifest(record.manifest);
  } catch (error: unknown) {
    if (error instanceof ArchiveManifestError) throw new StrictBackupError(error.message);
    throw error;
  }
  if (typeof record.groups !== "object" || record.groups === null || Array.isArray(record.groups)) {
    throw new StrictBackupError("Archive groups must be an object.");
  }
  const archive: ArchiveV4 = { manifest, groups: record.groups as ArchiveV4["groups"] };
  verifyChecksums(archive);
  return archive;
}

function serialize(archive: ArchiveV4): string {
  const body = `${JSON.stringify(archive, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_ARCHIVE_BYTES) {
    throw new StrictBackupError(
      `Archive is ${bytes} bytes, over the ${MAX_ARCHIVE_BYTES} byte safety limit; refusing to write a truncated file.`,
    );
  }
  return body;
}

export async function writeArchiveV4File(filePath: string, archive: ArchiveV4): Promise<void> {
  verifyChecksums(archive);
  const body = serialize(archive);
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.access(target, fsConstants.F_OK).then(
    () => {
      throw new StrictBackupError(`Archive target already exists: ${target}`);
    },
    (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    },
  );
  const tempPath = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(tempPath, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function readArchiveV4File(filePath: string): Promise<ArchiveV4> {
  const target = path.resolve(filePath);
  const linkStat = await fs.lstat(target);
  if (linkStat.isSymbolicLink()) {
    throw new StrictBackupError(`Archive path must not be a symbolic link: ${target}`);
  }
  let handle: FileHandle | undefined;
  let raw: string;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new StrictBackupError(`Archive path is not a file: ${target}`);
    if (stat.size > MAX_ARCHIVE_BYTES) {
      throw new StrictBackupError(`Archive exceeds the ${MAX_ARCHIVE_BYTES} byte safety limit.`);
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new StrictBackupError(
      `Archive is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseArchiveV4(parsed);
}
