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

const BACKUP_FORMAT = "jarvis-backup" as const;
const BACKUP_VERSION = 2 as const;
const LEGACY_BACKUP_VERSION = 1 as const;
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

export type BackupArchive = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  state: AssistantState;
  tasks: Task[];
  reminders: Reminder[];
};

export type RestoreResult = {
  taskIds: ReadonlyMap<string, string>;
  reminderIds: ReadonlyMap<string, string>;
  taskCount: number;
  reminderCount: number;
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
  if (value.version !== BACKUP_VERSION && value.version !== LEGACY_BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${String(value.version)}.`);
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("Backup has an invalid createdAt timestamp.");
  }
  if (!isRecord(value.state)) throw new Error("Backup state must be an object.");
  if (!Array.isArray(value.tasks)) throw new Error("Backup tasks must be an array.");
  if (!Array.isArray(value.reminders)) throw new Error("Backup reminders must be an array.");

  assertJsonSafe(value.state, "backup.state");
  const tasks = value.tasks.map(parseTask);
  const reminders = value.reminders.map((entry, index) =>
    parseReminder(entry, index, value.version as 1 | 2),
  );
  assertUniqueIds(tasks, "task");
  assertUniqueIds(reminders, "reminder");

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date(value.createdAt).toISOString(),
    state: cloneJson(value.state) as AssistantState,
    tasks: tasks.map((task) => ({ ...task })),
    reminders: reminders.map((reminder) => ({ ...reminder })),
  };
}

export async function exportBackup(
  provider: PersistenceProvider,
  now: () => Date = () => new Date(),
): Promise<BackupArchive> {
  if (!provider.snapshot) {
    throw new Error("Backup export requires an atomic persistence snapshot capability.");
  }
  const snapshot = await provider.snapshot();
  return parseBackup({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now().toISOString(),
    state: snapshot.state,
    tasks: snapshot.tasks,
    reminders: snapshot.reminders,
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

export function assertRestoredBackup(
  snapshot: PersistenceSnapshot,
  archive: BackupArchive,
  result: RestoreResult,
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

export async function restoreBackupIntoEmptyProvider(
  provider: PersistenceProvider,
  archiveInput: BackupArchive,
): Promise<RestoreResult> {
  const archive = parseBackup(archiveInput);
  if (!provider.restoreSnapshotIntoEmpty) {
    throw new Error("Backup restore requires an atomic empty-target restore capability.");
  }

  const restored = await provider.restoreSnapshotIntoEmpty({
    state: archive.state,
    tasks: archive.tasks,
    reminders: archive.reminders,
  });
  const result: RestoreResult = {
    taskIds: restored.taskIds,
    reminderIds: restored.reminderIds,
    taskCount: restored.taskIds.size,
    reminderCount: restored.reminderIds.size,
  };
  assertRestoredBackup(restored.snapshot, archive, result);
  return result;
}

export async function verifyBackupRestore(archive: BackupArchive): Promise<RestoreResult> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-backup-verify-"));
  try {
    const provider = new JSONPersistence(path.join(directory, "restored.json"));
    return await restoreBackupIntoEmptyProvider(provider, archive);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
