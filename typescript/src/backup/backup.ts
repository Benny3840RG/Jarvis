import fs, { constants as fsConstants, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  JSONPersistence,
  type AssistantState,
  type PersistenceProvider,
  type PersistenceSnapshot,
  type Reminder,
  type Task,
} from "../persistence/persistence.js";
import { validateReminderDue } from "../reminders/due.js";
import { isBuildStatus, type Build } from "../builds/build.js";
import { JsonBuildStore } from "../builds/jsonBuildStore.js";
import { isBuildLogKind, type BuildLogEntry } from "../buildLog/buildLogEntry.js";
import { JsonBuildLogStore } from "../buildLog/jsonBuildLogStore.js";
import type { Upgrade } from "../upgrades/upgrade.js";
import { JsonUpgradeStore } from "../upgrades/jsonUpgradeStore.js";
import type { Asset } from "../assets/asset.js";
import { JsonAssetStore } from "../assets/jsonAssetStore.js";
import type { Preference } from "../preferences/preference.js";
import { JsonPreferenceStore } from "../preferences/jsonPreferenceStore.js";
import type { MemoryStoreBundle } from "../importer/importMemoryStores.js";

const BACKUP_FORMAT = "jarvis-backup" as const;
const BACKUP_VERSION = 3 as const;
const V2_BACKUP_VERSION = 2 as const;
const LEGACY_BACKUP_VERSION = 1 as const;
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

/**
 * Builds/build logs/upgrades/assets/preferences: the "memory store" domains that
 * `npm run import:convex` already treats as one self-contained bundle. They were
 * added to the backup archive in version 3. Every other durable-memory domain
 * (clients, quotes, invoices, projects, properties, enquiries, errands, ...) is
 * cross-referenced by id (e.g. a quote holds a clientId) and is intentionally
 * NOT covered yet — restoring those safely needs a consistent id remap across
 * every domain that references them, not just a per-domain copy. See
 * typescript/docs/ROADMAP.md.
 */
export type BackupMemoryStores = MemoryStoreBundle;

export type BackupArchive = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  state: AssistantState;
  tasks: Task[];
  reminders: Reminder[];
  builds: Build[];
  buildLogs: BuildLogEntry[];
  upgrades: Upgrade[];
  assets: Asset[];
  preferences: Preference[];
};

export type RestoreResult = {
  taskIds: ReadonlyMap<string, string>;
  reminderIds: ReadonlyMap<string, string>;
  taskCount: number;
  reminderCount: number;
  buildIds: ReadonlyMap<string, string>;
  buildCount: number;
  buildLogCount: number;
  upgradeCount: number;
  assetCount: number;
  preferenceCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonSafe(value: unknown, location: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number.`);
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${location} contains a value that cannot be represented in JSON.`);
  }
  if (seen.has(value)) throw new Error(`${location} contains a circular reference.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, `${location}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${location} contains a non-plain object.`);
    }
    for (const [key, entry] of Object.entries(value)) {
      assertJsonSafe(entry, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function cloneJson<T>(value: T): T {
  assertJsonSafe(value, "backup");
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseTask(value: unknown, index: number): Task {
  if (!isRecord(value)) throw new Error(`Backup task ${index} must be an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`Backup task ${index} has an invalid id.`);
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new Error(`Backup task ${index} has an invalid title.`);
  }
  if (typeof value.completed !== "boolean") {
    throw new Error(`Backup task ${index} has an invalid completed flag.`);
  }
  if (typeof value.category !== "string" || value.category.length === 0) {
    throw new Error(`Backup task ${index} has an invalid category.`);
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error(`Backup task ${index} has an invalid createdAt value.`);
  }
  return {
    id: value.id,
    title: value.title,
    completed: value.completed,
    category: value.category,
    createdAt: value.createdAt,
  };
}

function parseReminder(value: unknown, index: number, version: 1 | 2): Reminder {
  if (!isRecord(value)) throw new Error(`Backup reminder ${index} must be an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`Backup reminder ${index} has an invalid id.`);
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new Error(`Backup reminder ${index} has an invalid title.`);
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error(`Backup reminder ${index} has an invalid createdAt value.`);
  }

  if (version === LEGACY_BACKUP_VERSION) {
    if (value.due !== undefined && typeof value.due !== "string") {
      throw new Error(`Backup reminder ${index} has an invalid due value.`);
    }
    return {
      id: value.id,
      title: value.title,
      ...(typeof value.due === "string" ? { dueRaw: value.due } : {}),
      createdAt: value.createdAt,
    };
  }

  if (value.due !== undefined) {
    throw new Error(`Backup reminder ${index} contains the retired due field.`);
  }
  if (
    value.dueRaw !== undefined &&
    (typeof value.dueRaw !== "string" || value.dueRaw.length === 0)
  ) {
    throw new Error(`Backup reminder ${index} has an invalid dueRaw value.`);
  }
  if (
    value.dueAt !== undefined &&
    (typeof value.dueAt !== "number" || !Number.isFinite(value.dueAt))
  ) {
    throw new Error(`Backup reminder ${index} has an invalid dueAt value.`);
  }
  if (
    value.dueTimezone !== undefined &&
    (typeof value.dueTimezone !== "string" || value.dueTimezone.length === 0)
  ) {
    throw new Error(`Backup reminder ${index} has an invalid dueTimezone value.`);
  }
  if ((value.dueAt === undefined) !== (value.dueTimezone === undefined)) {
    throw new Error(
      `Backup reminder ${index} must contain both dueAt and dueTimezone or neither value.`,
    );
  }
  if (value.dueAt !== undefined && value.dueRaw === undefined) {
    throw new Error(`Backup reminder ${index} has a normalized due value without dueRaw.`);
  }

  const due =
    typeof value.dueRaw === "string"
      ? validateReminderDue({
          raw: value.dueRaw,
          ...(typeof value.dueAt === "number"
            ? { at: value.dueAt, timezone: value.dueTimezone as string }
            : {}),
        })
      : undefined;
  return {
    id: value.id,
    title: value.title,
    ...(due === undefined
      ? {}
      : {
          dueRaw: due.raw,
          ...(due.at === undefined ? {} : { dueAt: due.at, dueTimezone: due.timezone as string }),
        }),
    createdAt: value.createdAt,
  };
}

function parseBuild(value: unknown, index: number): Build {
  if (!isRecord(value)) throw new Error(`Backup build ${index} must be an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`Backup build ${index} has an invalid id.`);
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`Backup build ${index} has an invalid name.`);
  }
  if (typeof value.kind !== "string" || value.kind.length === 0) {
    throw new Error(`Backup build ${index} has an invalid kind.`);
  }
  if (!isBuildStatus(value.status)) {
    throw new Error(`Backup build ${index} has an invalid status.`);
  }
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" || value.description.length === 0)
  ) {
    throw new Error(`Backup build ${index} has an invalid description.`);
  }
  if (
    value.nickname !== undefined &&
    (typeof value.nickname !== "string" || value.nickname.length === 0)
  ) {
    throw new Error(`Backup build ${index} has an invalid nickname.`);
  }
  if (value.notes !== undefined && (typeof value.notes !== "string" || value.notes.length === 0)) {
    throw new Error(`Backup build ${index} has an invalid notes value.`);
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error(`Backup build ${index} has an invalid createdAt value.`);
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
    throw new Error(`Backup build ${index} has an invalid updatedAt value.`);
  }
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    status: value.status,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.nickname === "string" ? { nickname: value.nickname } : {}),
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseBuildLogEntry(value: unknown, index: number): BuildLogEntry {
  if (!isRecord(value)) throw new Error(`Backup build log ${index} must be an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`Backup build log ${index} has an invalid id.`);
  }
  if (typeof value.buildId !== "string" || value.buildId.length === 0) {
    throw new Error(`Backup build log ${index} has an invalid buildId.`);
  }
  if (!isBuildLogKind(value.kind)) {
    throw new Error(`Backup build log ${index} has an invalid kind.`);
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new Error(`Backup build log ${index} has an invalid title.`);
  }
  if (value.body !== undefined && (typeof value.body !== "string" || value.body.length === 0)) {
    throw new Error(`Backup build log ${index} has an invalid body.`);
  }
  if (
    value.occurredAt !== undefined &&
    (typeof value.occurredAt !== "number" || !Number.isFinite(value.occurredAt))
  ) {
    throw new Error(`Backup build log ${index} has an invalid occurredAt value.`);
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error(`Backup build log ${index} has an invalid createdAt value.`);
  }
  if (
    value.updatedAt !== undefined &&
    (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt))
  ) {
    throw new Error(`Backup build log ${index} has an invalid updatedAt value.`);
  }
  return {
    id: value.id,
    buildId: value.buildId,
    kind: value.kind,
    title: value.title,
    ...(typeof value.body === "string" ? { body: value.body } : {}),
    ...(typeof value.occurredAt === "number" ? { occurredAt: value.occurredAt } : {}),
    createdAt: value.createdAt,
    ...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
  };
}

function parseUpgrade(value: unknown, index: number): Upgrade {
  if (!isRecord(value)) throw new Error(`Backup upgrade ${index} must be an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`Backup upgrade ${index} has an invalid id.`);
  }
  if (typeof value.buildId !== "string" || value.buildId.length === 0) {
    throw new Error(`Backup upgrade ${index} has an invalid buildId.`);
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new Error(`Backup upgrade ${index} has an invalid title.`);
  }
  if (
    value.reason !== undefined &&
    (typeof value.reason !== "string" || value.reason.length === 0)
  ) {
    throw new Error(`Backup upgrade ${index} has an invalid reason.`);
  }
  if (
    value.beforeState !== undefined &&
    (typeof value.beforeState !== "string" || value.beforeState.length === 0)
  ) {
    throw new Error(`Backup upgrade ${index} has an invalid beforeState value.`);
  }
  if (
    value.afterState !== undefined &&
    (typeof value.afterState !== "string" || value.afterState.length === 0)
  ) {
    throw new Error(`Backup upgrade ${index} has an invalid afterState value.`);
  }
  if (
    value.outcome !== undefined &&
    (typeof value.outcome !== "string" || value.outcome.length === 0)
  ) {
    throw new Error(`Backup upgrade ${index} has an invalid outcome value.`);
  }
  if (
    value.parts !== undefined &&
    (!Array.isArray(value.parts) || value.parts.some((part) => typeof part !== "string"))
  ) {
    throw new Error(`Backup upgrade ${index} has an invalid parts list.`);
  }
  if (
    value.version !== undefined &&
    (typeof value.version !== "string" || value.version.length === 0)
  ) {
    throw new Error(`Backup upgrade ${index} has an invalid version value.`);
  }
  if (
    value.occurredAt !== undefined &&
    (typeof value.occurredAt !== "number" || !Number.isFinite(value.occurredAt))
  ) {
    throw new Error(`Backup upgrade ${index} has an invalid occurredAt value.`);
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error(`Backup upgrade ${index} has an invalid createdAt value.`);
  }
  if (
    value.updatedAt !== undefined &&
    (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt))
  ) {
    throw new Error(`Backup upgrade ${index} has an invalid updatedAt value.`);
  }
  return {
    id: value.id,
    buildId: value.buildId,
    title: value.title,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.beforeState === "string" ? { beforeState: value.beforeState } : {}),
    ...(typeof value.afterState === "string" ? { afterState: value.afterState } : {}),
    ...(typeof value.outcome === "string" ? { outcome: value.outcome } : {}),
    ...(Array.isArray(value.parts) ? { parts: [...(value.parts as string[])] } : {}),
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.occurredAt === "number" ? { occurredAt: value.occurredAt } : {}),
    createdAt: value.createdAt,
    ...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
  };
}

function parseAsset(value: unknown, index: number): Asset {
  if (!isRecord(value)) throw new Error(`Backup asset ${index} must be an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`Backup asset ${index} has an invalid id.`);
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`Backup asset ${index} has an invalid name.`);
  }
  if (typeof value.kind !== "string" || value.kind.length === 0) {
    throw new Error(`Backup asset ${index} has an invalid kind.`);
  }
  if (
    value.serviceIntervalDays !== undefined &&
    (typeof value.serviceIntervalDays !== "number" || !Number.isFinite(value.serviceIntervalDays))
  ) {
    throw new Error(`Backup asset ${index} has an invalid serviceIntervalDays value.`);
  }
  if (
    value.lastServicedAt !== undefined &&
    (typeof value.lastServicedAt !== "number" || !Number.isFinite(value.lastServicedAt))
  ) {
    throw new Error(`Backup asset ${index} has an invalid lastServicedAt value.`);
  }
  if (value.notes !== undefined && (typeof value.notes !== "string" || value.notes.length === 0)) {
    throw new Error(`Backup asset ${index} has an invalid notes value.`);
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error(`Backup asset ${index} has an invalid createdAt value.`);
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
    throw new Error(`Backup asset ${index} has an invalid updatedAt value.`);
  }
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    ...(typeof value.serviceIntervalDays === "number"
      ? { serviceIntervalDays: value.serviceIntervalDays }
      : {}),
    ...(typeof value.lastServicedAt === "number" ? { lastServicedAt: value.lastServicedAt } : {}),
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parsePreference(value: unknown, index: number): Preference {
  if (!isRecord(value)) throw new Error(`Backup preference ${index} must be an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`Backup preference ${index} has an invalid id.`);
  }
  if (typeof value.key !== "string" || value.key.length === 0) {
    throw new Error(`Backup preference ${index} has an invalid key.`);
  }
  if (typeof value.value !== "string" || value.value.length === 0) {
    throw new Error(`Backup preference ${index} has an invalid value.`);
  }
  if (
    value.category !== undefined &&
    (typeof value.category !== "string" || value.category.length === 0)
  ) {
    throw new Error(`Backup preference ${index} has an invalid category.`);
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error(`Backup preference ${index} has an invalid createdAt value.`);
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
    throw new Error(`Backup preference ${index} has an invalid updatedAt value.`);
  }
  return {
    id: value.id,
    key: value.key,
    value: value.value,
    ...(typeof value.category === "string" ? { category: value.category } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function assertUniqueIds(records: Array<{ id: string }>, name: string): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id))
      throw new Error(`Backup contains a duplicate ${name} id: ${record.id}.`);
    ids.add(record.id);
  }
}

export function parseBackup(value: unknown): BackupArchive {
  if (!isRecord(value)) throw new Error("Backup must be an object.");
  if (value.format !== BACKUP_FORMAT) throw new Error("Unsupported backup format.");
  if (
    value.version !== BACKUP_VERSION &&
    value.version !== V2_BACKUP_VERSION &&
    value.version !== LEGACY_BACKUP_VERSION
  ) {
    throw new Error(`Unsupported backup version: ${String(value.version)}.`);
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("Backup has an invalid createdAt timestamp.");
  }
  if (!isRecord(value.state)) throw new Error("Backup state must be an object.");
  if (!Array.isArray(value.tasks)) throw new Error("Backup tasks must be an array.");
  if (!Array.isArray(value.reminders)) throw new Error("Backup reminders must be an array.");

  const hasMemoryDomains = value.version === BACKUP_VERSION;
  if (hasMemoryDomains) {
    for (const field of ["builds", "buildLogs", "upgrades", "assets", "preferences"] as const) {
      if (!Array.isArray(value[field])) throw new Error(`Backup ${field} must be an array.`);
    }
  }

  assertJsonSafe(value.state, "backup.state");
  const tasks = value.tasks.map(parseTask);
  const reminders = value.reminders.map((entry, index) =>
    parseReminder(entry, index, value.version === LEGACY_BACKUP_VERSION ? 1 : 2),
  );
  const builds = hasMemoryDomains ? (value.builds as unknown[]).map(parseBuild) : [];
  const buildLogs = hasMemoryDomains ? (value.buildLogs as unknown[]).map(parseBuildLogEntry) : [];
  const upgrades = hasMemoryDomains ? (value.upgrades as unknown[]).map(parseUpgrade) : [];
  const assets = hasMemoryDomains ? (value.assets as unknown[]).map(parseAsset) : [];
  const preferences = hasMemoryDomains ? (value.preferences as unknown[]).map(parsePreference) : [];
  assertUniqueIds(tasks, "task");
  assertUniqueIds(reminders, "reminder");
  assertUniqueIds(builds, "build");
  assertUniqueIds(buildLogs, "build log");
  assertUniqueIds(upgrades, "upgrade");
  assertUniqueIds(assets, "asset");
  assertUniqueIds(preferences, "preference");

  const buildIds = new Set(builds.map((build) => build.id));
  for (const log of buildLogs) {
    if (!buildIds.has(log.buildId)) {
      throw new Error(`Backup build log ${log.id} references unknown build ${log.buildId}.`);
    }
  }
  for (const upgrade of upgrades) {
    if (!buildIds.has(upgrade.buildId)) {
      throw new Error(`Backup upgrade ${upgrade.id} references unknown build ${upgrade.buildId}.`);
    }
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date(value.createdAt).toISOString(),
    state: cloneJson(value.state) as AssistantState,
    tasks: tasks.map((task) => ({ ...task })),
    reminders: reminders.map((reminder) => ({ ...reminder })),
    builds: builds.map((build) => ({ ...build })),
    buildLogs: buildLogs.map((log) => ({ ...log })),
    upgrades: upgrades.map((upgrade) => ({ ...upgrade })),
    assets: assets.map((asset) => ({ ...asset })),
    preferences: preferences.map((preference) => ({ ...preference })),
  };
}

export async function exportBackup(
  provider: PersistenceProvider,
  now: () => Date = () => new Date(),
  memoryStores?: BackupMemoryStores,
): Promise<BackupArchive> {
  if (!provider.snapshot) {
    throw new Error("Backup export requires an atomic persistence snapshot capability.");
  }
  const snapshot = await provider.snapshot();
  const [builds, buildLogs, upgrades, assets, preferences] = memoryStores
    ? await Promise.all([
        memoryStores.builds.list(),
        memoryStores.buildLogs.list(),
        memoryStores.upgrades.list(),
        memoryStores.assets.list(),
        memoryStores.preferences.list(),
      ])
    : [[], [], [], [], []];
  return parseBackup({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now().toISOString(),
    state: snapshot.state,
    tasks: snapshot.tasks,
    reminders: snapshot.reminders,
    builds,
    buildLogs,
    upgrades,
    assets,
    preferences,
  });
}

export async function writeBackupFile(filePath: string, archive: BackupArchive): Promise<void> {
  const validated = parseBackup(archive);
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.access(target, fsConstants.F_OK).then(
    () => {
      throw new Error(`Backup target already exists: ${target}`);
    },
    (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    },
  );

  const tempPath = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(tempPath, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function readBackupFile(filePath: string): Promise<BackupArchive> {
  const target = path.resolve(filePath);
  const linkStat = await fs.lstat(target);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Backup path must not be a symbolic link: ${target}`);
  }

  let handle: FileHandle | undefined;
  let raw: string;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Backup path is not a file: ${target}`);
    if (stat.size > MAX_BACKUP_BYTES) {
      throw new Error(`Backup exceeds the ${MAX_BACKUP_BYTES} byte safety limit.`);
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  try {
    return parseBackup(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    throw new Error(
      `Invalid Jarvis backup: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function remapIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => remapIds(entry, ids));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, remapIds(entry, ids)]),
    );
  }
  return value;
}

function taskSignatures(tasks: Task[]): string[] {
  return tasks.map((task) => JSON.stringify([task.title, task.completed, task.category])).sort();
}

function reminderSignatures(reminders: Reminder[]): string[] {
  return reminders
    .map((reminder) =>
      JSON.stringify([
        reminder.title,
        reminder.dueRaw ?? null,
        reminder.dueAt ?? null,
        reminder.dueTimezone ?? null,
      ]),
    )
    .sort();
}

function buildSignatureById(builds: Build[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const build of builds) {
    map.set(
      build.id,
      JSON.stringify([
        build.name,
        build.kind,
        build.status,
        build.description ?? null,
        build.nickname ?? null,
        build.notes ?? null,
      ]),
    );
  }
  return map;
}

function buildLogSignatures(
  logs: BuildLogEntry[],
  buildSignatureByBuildId: ReadonlyMap<string, string>,
): string[] {
  return logs
    .map((log) =>
      JSON.stringify([
        buildSignatureByBuildId.get(log.buildId) ?? null,
        log.kind,
        log.title,
        log.body ?? null,
        log.occurredAt ?? null,
      ]),
    )
    .sort();
}

function upgradeSignatures(
  upgrades: Upgrade[],
  buildSignatureByBuildId: ReadonlyMap<string, string>,
): string[] {
  return upgrades
    .map((upgrade) =>
      JSON.stringify([
        buildSignatureByBuildId.get(upgrade.buildId) ?? null,
        upgrade.title,
        upgrade.reason ?? null,
        upgrade.beforeState ?? null,
        upgrade.afterState ?? null,
        upgrade.outcome ?? null,
        upgrade.parts ?? null,
        upgrade.version ?? null,
        upgrade.occurredAt ?? null,
      ]),
    )
    .sort();
}

function assetSignatures(assets: Asset[]): string[] {
  return assets
    .map((asset) =>
      JSON.stringify([
        asset.name,
        asset.kind,
        asset.serviceIntervalDays ?? null,
        asset.lastServicedAt ?? null,
        asset.notes ?? null,
      ]),
    )
    .sort();
}

function preferenceSignatures(preferences: Preference[]): string[] {
  return preferences
    .map((preference) =>
      JSON.stringify([preference.key, preference.value, preference.category ?? null]),
    )
    .sort();
}

export function assertRestoredBackup(
  snapshot: PersistenceSnapshot,
  archive: BackupArchive,
  result: Pick<RestoreResult, "taskIds" | "reminderIds">,
): void {
  const allIds = new Map<string, string>([
    ...result.taskIds.entries(),
    ...result.reminderIds.entries(),
  ]);
  const expectedState = remapIds(archive.state, allIds);
  if (!isDeepStrictEqual(snapshot.state, expectedState)) {
    throw new Error("Restored assistant state does not match the backup.");
  }
  if (!isDeepStrictEqual(taskSignatures(snapshot.tasks), taskSignatures(archive.tasks))) {
    throw new Error("Restored tasks do not match the backup.");
  }
  if (
    !isDeepStrictEqual(
      reminderSignatures(snapshot.reminders),
      reminderSignatures(archive.reminders),
    )
  ) {
    throw new Error("Restored reminders do not match the backup.");
  }
}

type RestoredMemory = {
  buildIds: ReadonlyMap<string, string>;
  builds: Build[];
  buildLogs: BuildLogEntry[];
  upgrades: Upgrade[];
  assets: Asset[];
  preferences: Preference[];
};

const EMPTY_RESTORED_MEMORY: RestoredMemory = {
  buildIds: new Map(),
  builds: [],
  buildLogs: [],
  upgrades: [],
  assets: [],
  preferences: [],
};

/**
 * Populates the five memory-store domains from an already-parsed archive. Unlike
 * the core state/tasks/reminders restore, this is NOT atomic — each record is a
 * separate store.add() call (the same limitation `importMemoryStores` accepts).
 * Callers must therefore only invoke this after every up-front emptiness check
 * has passed, so the only way it can fail partway through is a genuine store
 * error, not a refused precondition.
 */
async function restoreMemoryStores(
  memoryStores: BackupMemoryStores,
  archive: BackupArchive,
): Promise<RestoredMemory> {
  const buildIds = new Map<string, string>();
  const builds: Build[] = [];
  for (const build of archive.builds) {
    const created = await memoryStores.builds.add({
      name: build.name,
      kind: build.kind,
      status: build.status,
      ...(build.description === undefined ? {} : { description: build.description }),
      ...(build.nickname === undefined ? {} : { nickname: build.nickname }),
      ...(build.notes === undefined ? {} : { notes: build.notes }),
    });
    buildIds.set(build.id, created.id);
    builds.push(created);
  }

  const buildLogs: BuildLogEntry[] = [];
  for (const log of archive.buildLogs) {
    const buildId = buildIds.get(log.buildId);
    if (buildId === undefined) {
      throw new Error(
        `Backup restore refused: build log ${log.id} references unknown build ${log.buildId}.`,
      );
    }
    buildLogs.push(
      await memoryStores.buildLogs.add({
        buildId,
        title: log.title,
        kind: log.kind,
        ...(log.body === undefined ? {} : { body: log.body }),
        ...(log.occurredAt === undefined ? {} : { occurredAt: log.occurredAt }),
      }),
    );
  }

  const upgrades: Upgrade[] = [];
  for (const upgrade of archive.upgrades) {
    const buildId = buildIds.get(upgrade.buildId);
    if (buildId === undefined) {
      throw new Error(
        `Backup restore refused: upgrade ${upgrade.id} references unknown build ${upgrade.buildId}.`,
      );
    }
    upgrades.push(
      await memoryStores.upgrades.add({
        buildId,
        title: upgrade.title,
        ...(upgrade.reason === undefined ? {} : { reason: upgrade.reason }),
        ...(upgrade.beforeState === undefined ? {} : { beforeState: upgrade.beforeState }),
        ...(upgrade.afterState === undefined ? {} : { afterState: upgrade.afterState }),
        ...(upgrade.outcome === undefined ? {} : { outcome: upgrade.outcome }),
        ...(upgrade.parts === undefined ? {} : { parts: upgrade.parts }),
        ...(upgrade.version === undefined ? {} : { version: upgrade.version }),
        ...(upgrade.occurredAt === undefined ? {} : { occurredAt: upgrade.occurredAt }),
      }),
    );
  }

  const assets: Asset[] = [];
  for (const asset of archive.assets) {
    assets.push(
      await memoryStores.assets.add({
        name: asset.name,
        kind: asset.kind,
        ...(asset.serviceIntervalDays === undefined
          ? {}
          : { serviceIntervalDays: asset.serviceIntervalDays }),
        ...(asset.lastServicedAt === undefined ? {} : { lastServicedAt: asset.lastServicedAt }),
        ...(asset.notes === undefined ? {} : { notes: asset.notes }),
      }),
    );
  }

  const preferences: Preference[] = [];
  for (const preference of archive.preferences) {
    preferences.push(
      await memoryStores.preferences.add({
        key: preference.key,
        value: preference.value,
        ...(preference.category === undefined ? {} : { category: preference.category }),
      }),
    );
  }

  return { buildIds, builds, buildLogs, upgrades, assets, preferences };
}

function assertRestoredMemoryStores(restored: RestoredMemory, archive: BackupArchive): void {
  const restoredBuildSignatures = buildSignatureById(restored.builds);
  const archiveBuildSignatures = buildSignatureById(archive.builds);
  if (
    !isDeepStrictEqual(
      [...restoredBuildSignatures.values()].sort(),
      [...archiveBuildSignatures.values()].sort(),
    )
  ) {
    throw new Error("Restored builds do not match the backup.");
  }
  if (
    !isDeepStrictEqual(
      buildLogSignatures(restored.buildLogs, restoredBuildSignatures),
      buildLogSignatures(archive.buildLogs, archiveBuildSignatures),
    )
  ) {
    throw new Error("Restored build logs do not match the backup.");
  }
  if (
    !isDeepStrictEqual(
      upgradeSignatures(restored.upgrades, restoredBuildSignatures),
      upgradeSignatures(archive.upgrades, archiveBuildSignatures),
    )
  ) {
    throw new Error("Restored upgrades do not match the backup.");
  }
  if (!isDeepStrictEqual(assetSignatures(restored.assets), assetSignatures(archive.assets))) {
    throw new Error("Restored assets do not match the backup.");
  }
  if (
    !isDeepStrictEqual(
      preferenceSignatures(restored.preferences),
      preferenceSignatures(archive.preferences),
    )
  ) {
    throw new Error("Restored preferences do not match the backup.");
  }
}

export async function restoreBackupIntoEmptyProvider(
  provider: PersistenceProvider,
  archiveInput: BackupArchive,
  memoryStores?: BackupMemoryStores,
): Promise<RestoreResult> {
  const archive = parseBackup(archiveInput);
  if (!provider.restoreSnapshotIntoEmpty) {
    throw new Error("Backup restore requires an atomic empty-target restore capability.");
  }

  const hasMemoryData =
    archive.builds.length > 0 ||
    archive.buildLogs.length > 0 ||
    archive.upgrades.length > 0 ||
    archive.assets.length > 0 ||
    archive.preferences.length > 0;
  if (hasMemoryData && !memoryStores) {
    throw new Error(
      "Backup restore refused: the archive contains build, build log, upgrade, asset, or preference records but no memory stores were supplied to restore them into.",
    );
  }

  if (memoryStores) {
    const [
      existingBuilds,
      existingBuildLogs,
      existingUpgrades,
      existingAssets,
      existingPreferences,
    ] = await Promise.all([
      memoryStores.builds.list(),
      memoryStores.buildLogs.list(),
      memoryStores.upgrades.list(),
      memoryStores.assets.list(),
      memoryStores.preferences.list(),
    ]);
    const nonEmpty: string[] = [];
    if (existingBuilds.length > 0) nonEmpty.push("build");
    if (existingBuildLogs.length > 0) nonEmpty.push("build log");
    if (existingUpgrades.length > 0) nonEmpty.push("upgrade");
    if (existingAssets.length > 0) nonEmpty.push("asset");
    if (existingPreferences.length > 0) nonEmpty.push("preference");
    if (nonEmpty.length > 0) {
      throw new Error(`Restore refused: the target ${nonEmpty.join("/")} store is not empty.`);
    }
  }

  const restored = await provider.restoreSnapshotIntoEmpty({
    state: archive.state,
    tasks: archive.tasks,
    reminders: archive.reminders,
  });
  const coreResult = {
    taskIds: restored.taskIds,
    reminderIds: restored.reminderIds,
    taskCount: restored.taskIds.size,
    reminderCount: restored.reminderIds.size,
  };
  assertRestoredBackup(restored.snapshot, archive, coreResult);

  const restoredMemory = memoryStores
    ? await restoreMemoryStores(memoryStores, archive)
    : EMPTY_RESTORED_MEMORY;
  assertRestoredMemoryStores(restoredMemory, archive);

  return {
    ...coreResult,
    buildIds: restoredMemory.buildIds,
    buildCount: restoredMemory.builds.length,
    buildLogCount: restoredMemory.buildLogs.length,
    upgradeCount: restoredMemory.upgrades.length,
    assetCount: restoredMemory.assets.length,
    preferenceCount: restoredMemory.preferences.length,
  };
}

export async function verifyBackupRestore(archive: BackupArchive): Promise<RestoreResult> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-backup-verify-"));
  try {
    const provider = new JSONPersistence(path.join(directory, "restored.json"));
    const memoryStores: BackupMemoryStores = {
      builds: new JsonBuildStore(path.join(directory, "builds.json")),
      buildLogs: new JsonBuildLogStore(path.join(directory, "build-logs.json")),
      upgrades: new JsonUpgradeStore(path.join(directory, "upgrades.json")),
      assets: new JsonAssetStore(path.join(directory, "assets.json")),
      preferences: new JsonPreferenceStore(path.join(directory, "preferences.json")),
    };
    return await restoreBackupIntoEmptyProvider(provider, archive, memoryStores);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
