import type { Asset } from "../../assets/asset.js";
import type { Build } from "../../builds/build.js";
import type { BuildLogEntry } from "../../buildLog/buildLogEntry.js";
import { JsonFileLock } from "../../persistence/jsonFileLock.js";
import { businessDataFiles, coreDataFiles } from "../../persistence/jarvisDataPaths.js";
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
  assertJsonSafe,
  assertNoUnknownKeys,
  assertRecord,
  fail,
  isRecord,
  StrictBackupError,
} from "../strictValues.js";
import {
  assertDocumentVersion,
  parseRows,
  readArrayDocument,
  readRawJson,
} from "./strictDocument.js";
import {
  BUSINESS_LOCK_ORDER,
  readBusinessGroup,
  type BusinessRecordsPayload,
} from "./businessSource.js";

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
export const CAPTURE_LOCK_ORDER: ReadonlyArray<keyof CapturePaths> = [
  "state",
  "builds",
  "buildLogs",
  "upgrades",
  "assets",
  "preferences",
  ...BUSINESS_LOCK_ORDER,
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
  businessRecords: BusinessRecordsPayload;
};

export type CapturePaths = typeof coreDataFiles & typeof businessDataFiles;

/** Every JSON-backed file archive v4 covers, in one object. */
export const ALL_CAPTURE_FILES: CapturePaths = { ...coreDataFiles, ...businessDataFiles };

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
    readArrayDocument(
      paths.builds,
      "builds",
      MEMORY_DOCUMENT_VERSION,
      BUILD_KEYS,
      parseBuild,
      "build",
    ),
    readArrayDocument(
      paths.buildLogs,
      "entries",
      MEMORY_DOCUMENT_VERSION,
      BUILD_LOG_KEYS,
      parseBuildLogEntry,
      "build log",
    ),
    readArrayDocument(
      paths.upgrades,
      "entries",
      MEMORY_DOCUMENT_VERSION,
      UPGRADE_KEYS,
      parseUpgrade,
      "upgrade",
    ),
    readArrayDocument(
      paths.assets,
      "entries",
      MEMORY_DOCUMENT_VERSION,
      ASSET_KEYS,
      parseAsset,
      "asset",
    ),
    readArrayDocument(
      paths.preferences,
      "entries",
      MEMORY_DOCUMENT_VERSION,
      PREFERENCE_KEYS,
      parsePreference,
      "preference",
    ),
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
  paths: CapturePaths = ALL_CAPTURE_FILES,
): CapturePaths {
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
  paths: CapturePaths,
  options: { lockTimeoutMs?: number; warn?: PersistenceWarning } = {},
): Promise<JsonCapture> {
  const timeout = options.lockTimeoutMs ?? 10_000;
  const warn = options.warn ?? (() => {});
  const locks = CAPTURE_LOCK_ORDER.map((key) => new JsonFileLock(paths[key], warn, timeout));
  const read = async (): Promise<JsonCapture> => ({
    core: await readCoreGroup(paths.state),
    memory: await readMemoryGroup(paths),
    businessRecords: await readBusinessGroup(paths),
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
