import fs, { constants as fsConstants, type FileHandle } from "node:fs/promises";

import type { Asset } from "../../assets/asset.js";
import type { Build } from "../../builds/build.js";
import type { BuildLogEntry } from "../../buildLog/buildLogEntry.js";
import { JsonFileLock } from "../../persistence/jsonFileLock.js";
import { coreDataFiles } from "../../persistence/jarvisDataPaths.js";
import type {
  AssistantState,
  PersistenceWarning,
  Reminder,
  Task,
} from "../../persistence/persistence.js";
import { resolvePersistenceProviderName } from "../../persistence/providerSelection.js";
import type { Preference } from "../../preferences/preference.js";
import type { Upgrade } from "../../upgrades/upgrade.js";
import {
  assertUniqueIds,
  parseAsset,
  parseBuild,
  parseBuildLogEntry,
  parsePreference,
  parseReminder,
  parseTask,
  parseUpgrade,
} from "../backup.js";
import { sortUnresolvedReferences, type ArchiveUnresolvedReference } from "../archiveManifest.js";
import {
  assertArray,
  assertJsonSafe,
  assertNoUnknownKeys,
  assertRecord,
  fail,
  isRecord,
  StrictBackupError,
} from "../strictValues.js";

/**
 * Archive v4, stage 2: strict, lossless capture of the JSON-backed `core` and
 * `memory` groups.
 *
 * Reads raw bytes rather than going through the stores, because the stores'
 * `readDocument()` is deliberately forgiving — it quarantines a malformed file,
 * skips invalid rows and defaults missing timestamps. A backup that did that
 * would silently produce a smaller, different dataset than the source. Here an
 * unreadable or invalid source aborts the whole capture; only a file that has
 * genuinely never been created (`ENOENT`) is reported as empty.
 */

export const CORE_FILE_KEYS = ["state"] as const;
export const MEMORY_FILE_KEYS = [
  "builds",
  "buildLogs",
  "upgrades",
  "assets",
  "preferences",
] as const;

export type JsonSourceKey = keyof typeof coreDataFiles;

/**
 * Lock-acquisition order for a coherent capture. Fixed and shared so two
 * captures can never deadlock against each other, and stable so the order is
 * reviewable rather than incidental.
 */
export const CAPTURE_LOCK_ORDER: readonly JsonSourceKey[] = [
  "state",
  "builds",
  "buildLogs",
  "upgrades",
  "assets",
  "preferences",
];

const STATE_DOCUMENT_VERSION = 2;
const MEMORY_DOCUMENT_VERSION = 1;

const TASK_KEYS = ["id", "title", "completed", "category", "createdAt"] as const;
const REMINDER_KEYS = ["id", "title", "dueRaw", "dueAt", "dueTimezone", "createdAt"] as const;
const BUILD_KEYS = [
  "id",
  "name",
  "kind",
  "status",
  "description",
  "nickname",
  "notes",
  "createdAt",
  "updatedAt",
] as const;
const BUILD_LOG_KEYS = [
  "id",
  "buildId",
  "kind",
  "title",
  "body",
  "occurredAt",
  "createdAt",
  "updatedAt",
] as const;
const UPGRADE_KEYS = [
  "id",
  "buildId",
  "title",
  "reason",
  "beforeState",
  "afterState",
  "outcome",
  "parts",
  "version",
  "occurredAt",
  "createdAt",
  "updatedAt",
] as const;
const ASSET_KEYS = [
  "id",
  "name",
  "kind",
  "serviceIntervalDays",
  "lastServicedAt",
  "notes",
  "createdAt",
  "updatedAt",
] as const;
const PREFERENCE_KEYS = ["id", "key", "value", "category", "createdAt", "updatedAt"] as const;

export type CoreGroupPayload = {
  state: AssistantState;
  tasks: Task[];
  reminders: Reminder[];
};

export type MemoryGroupPayload = {
  builds: Build[];
  buildLogs: BuildLogEntry[];
  upgrades: Upgrade[];
  assets: Asset[];
  preferences: Preference[];
};

export type JsonCapture = {
  core: CoreGroupPayload;
  memory: MemoryGroupPayload;
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Reads and parses one covered file. `null` means the file has never existed. */
async function readRawJson(filePath: string): Promise<unknown | null> {
  const linkStat = await fs.lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw new StrictBackupError(
      `Backup source ${filePath} could not be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (linkStat === null) return null;
  if (linkStat.isSymbolicLink()) {
    throw new StrictBackupError(
      `Backup source ${filePath} is a symbolic link; refusing to follow it.`,
    );
  }

  let handle: FileHandle | undefined;
  let raw: string;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new StrictBackupError(`Backup source ${filePath} is not a regular file.`);
    raw = await handle.readFile("utf8");
  } catch (error: unknown) {
    if (error instanceof StrictBackupError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw new StrictBackupError(
      `Backup source ${filePath} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new StrictBackupError(
      `Backup source ${filePath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertDocumentVersion(
  document: Record<string, unknown>,
  expected: number,
  filePath: string,
): void {
  if (!("version" in document)) {
    throw new StrictBackupError(`Backup source ${filePath} is missing its document version.`);
  }
  if (document.version !== expected) {
    throw new StrictBackupError(
      `Backup source ${filePath} has unsupported document version ${String(document.version)} (expected ${expected}).`,
    );
  }
}

function parseRows<T extends { id: string }>(
  rows: unknown,
  filePath: string,
  arrayKey: string,
  allowed: readonly string[],
  parse: (value: unknown, index: number) => T,
  noun: string,
): T[] {
  const array = assertArray(rows, `${filePath} "${arrayKey}"`);
  const records = array.map((row, index) => {
    const record = assertRecord(row, `${filePath} ${arrayKey}[${index}]`);
    assertNoUnknownKeys(record, allowed, `${filePath} ${arrayKey}[${index}]`);
    return parse(row, index);
  });
  assertUniqueIds(records, noun);
  return records;
}

async function readArrayDocument<T extends { id: string }>(
  filePath: string,
  arrayKey: string,
  allowed: readonly string[],
  parse: (value: unknown, index: number) => T,
  noun: string,
): Promise<T[]> {
  const raw = await readRawJson(filePath);
  if (raw === null) return [];
  const document = assertRecord(raw, `Backup source ${filePath}`);
  assertDocumentVersion(document, MEMORY_DOCUMENT_VERSION, filePath);
  assertNoUnknownKeys(document, ["version", arrayKey], `Backup source ${filePath}`);
  if (!(arrayKey in document)) {
    throw new StrictBackupError(`Backup source ${filePath} is missing its "${arrayKey}" array.`);
  }
  return parseRows(document[arrayKey], filePath, arrayKey, allowed, parse, noun);
}

export async function readCoreGroup(filePath: string): Promise<CoreGroupPayload> {
  const raw = await readRawJson(filePath);
  if (raw === null) return { state: {}, tasks: [], reminders: [] };
  const document = assertRecord(raw, `Backup source ${filePath}`);
  assertDocumentVersion(document, STATE_DOCUMENT_VERSION, filePath);
  assertNoUnknownKeys(
    document,
    ["version", "state", "tasks", "reminders"],
    `Backup source ${filePath}`,
  );
  if (!isRecord(document.state)) fail(`Backup source ${filePath} "state"`, "must be an object.");
  assertJsonSafe(document.state, `Backup source ${filePath} "state"`);
  return {
    state: document.state as AssistantState,
    tasks: parseRows(document.tasks, filePath, "tasks", TASK_KEYS, parseTask, "task"),
    reminders: parseRows(
      document.reminders,
      filePath,
      "reminders",
      REMINDER_KEYS,
      (row, index) => parseReminder(row, index, 2),
      "reminder",
    ),
  };
}

export async function readMemoryGroup(
  paths: Pick<typeof coreDataFiles, "builds" | "buildLogs" | "upgrades" | "assets" | "preferences">,
): Promise<MemoryGroupPayload> {
  const [builds, buildLogs, upgrades, assets, preferences] = await Promise.all([
    readArrayDocument(paths.builds, "builds", BUILD_KEYS, parseBuild, "build"),
    readArrayDocument(paths.buildLogs, "entries", BUILD_LOG_KEYS, parseBuildLogEntry, "build log"),
    readArrayDocument(paths.upgrades, "entries", UPGRADE_KEYS, parseUpgrade, "upgrade"),
    readArrayDocument(paths.assets, "entries", ASSET_KEYS, parseAsset, "asset"),
    readArrayDocument(paths.preferences, "entries", PREFERENCE_KEYS, parsePreference, "preference"),
  ]);
  return { builds, buildLogs, upgrades, assets, preferences };
}

/**
 * Build references that the source itself cannot resolve.
 *
 * Deleting a build does **not** cascade to its logs and upgrades, and no
 * dependency guard prevents it (`buildController` matches an error message that
 * nothing throws), so an orphaned log is a legal state of live data. Refusing
 * to capture it would make the backup unusable after an ordinary deletion and
 * would lose the orphaned rows, which are still authoritative. They are captured
 * verbatim and the broken edge is recorded instead.
 */
export function memoryUnresolvedReferences(
  payload: MemoryGroupPayload,
): ArchiveUnresolvedReference[] {
  const buildIds = new Set(payload.builds.map((build) => build.id));
  const unresolved: ArchiveUnresolvedReference[] = [];
  const check = (
    collection: string,
    rows: ReadonlyArray<{ id: string; buildId: string }>,
  ): void => {
    for (const row of rows) {
      if (buildIds.has(row.buildId)) continue;
      unresolved.push({
        group: "memory",
        collection,
        recordId: row.id,
        field: "buildId",
        value: row.buildId,
        targetCollection: "builds",
      });
    }
  };
  check("buildLogs", payload.buildLogs);
  check("upgrades", payload.upgrades);
  return sortUnresolvedReferences(unresolved);
}

/**
 * Capability check. Archive v4 currently captures the JSON-backed groups only,
 * so a Convex-selected deployment is refused rather than silently producing an
 * archive that omits the data actually in use.
 */
export function resolveJsonSourceConfig(
  providerName = resolvePersistenceProviderName(),
  paths: typeof coreDataFiles = coreDataFiles,
): typeof coreDataFiles {
  if (providerName !== "json") {
    throw new StrictBackupError(
      `Archive v4 captures JSON-backed groups only, but PERSISTENCE_PROVIDER selects "${providerName}". Refusing; archive v1-v3 is unaffected.`,
    );
  }
  return paths;
}

/**
 * Holds every covered file's lock for the whole read, so no Jarvis writer can
 * mutate one file after another has been captured. Reads are raw-byte reads, so
 * no lock is ever re-entered through a store API.
 */
export async function captureJsonGroups(
  paths: typeof coreDataFiles,
  options: { lockTimeoutMs?: number; warn?: PersistenceWarning } = {},
): Promise<JsonCapture> {
  const timeout = options.lockTimeoutMs ?? 10_000;
  const warn = options.warn ?? (() => {});
  const locks = CAPTURE_LOCK_ORDER.map((key) => new JsonFileLock(paths[key], warn, timeout));
  const read = async (): Promise<JsonCapture> => ({
    core: await readCoreGroup(paths.state),
    memory: await readMemoryGroup(paths),
  });
  const run = locks.reduceRight<() => Promise<JsonCapture>>(
    (inner, lock) => () => lock.run(inner, "archive v4 coherent capture"),
    read,
  );
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof StrictBackupError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/locked by|state lock/i.test(message)) {
      throw new StrictBackupError(`Archive v4 could not establish a coherent snapshot: ${message}`);
    }
    throw error;
  }
}
