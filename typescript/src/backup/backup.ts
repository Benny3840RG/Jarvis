import fs, { constants as fsConstants, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  JSONPersistence,
  type AssistantState,
  type PersistenceProvider,
  type Reminder,
  type Task,
} from "../persistence/persistence.js";

const BACKUP_FORMAT = "jarvis-backup" as const;
const BACKUP_VERSION = 1 as const;
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

function parseReminder(value: unknown, index: number): Reminder {
  if (!isRecord(value)) throw new Error(`Backup reminder ${index} must be an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`Backup reminder ${index} has an invalid id.`);
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new Error(`Backup reminder ${index} has an invalid title.`);
  }
  if (value.due !== undefined && typeof value.due !== "string") {
    throw new Error(`Backup reminder ${index} has an invalid due value.`);
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error(`Backup reminder ${index} has an invalid createdAt value.`);
  }
  return {
    id: value.id,
    title: value.title,
    ...(value.due === undefined ? {} : { due: value.due }),
    createdAt: value.createdAt,
  };
}

function assertUniqueIds(records: Array<{ id: string }>, name: string): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Backup contains a duplicate ${name} id: ${record.id}.`);
    ids.add(record.id);
  }
}

export function parseBackup(value: unknown): BackupArchive {
  if (!isRecord(value)) throw new Error("Backup must be an object.");
  if (value.format !== BACKUP_FORMAT) throw new Error("Unsupported backup format.");
  if (value.version !== BACKUP_VERSION) {
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
  const reminders = value.reminders.map(parseReminder);
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
  const [state, tasks, reminders] = await Promise.all([
    provider.loadState(),
    provider.listTasks(),
    provider.listReminders(),
  ]);
  return parseBackup({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now().toISOString(),
    state,
    tasks,
    reminders,
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
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error(`Backup path is not a file: ${target}`);
  if (stat.size > MAX_BACKUP_BYTES) {
    throw new Error(`Backup exceeds the ${MAX_BACKUP_BYTES} byte safety limit.`);
  }
  const raw = await fs.readFile(target, "utf8");
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
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remapIds(entry, ids)]));
  }
  return value;
}

function taskSignatures(tasks: Task[]): string[] {
  return tasks
    .map((task) => JSON.stringify([task.title, task.completed, task.category]))
    .sort();
}

function reminderSignatures(reminders: Reminder[]): string[] {
  return reminders
    .map((reminder) => JSON.stringify([reminder.title, reminder.due ?? null]))
    .sort();
}

export async function assertRestoredBackup(
  provider: PersistenceProvider,
  archive: BackupArchive,
  result: RestoreResult,
): Promise<void> {
  const [state, tasks, reminders] = await Promise.all([
    provider.loadState(),
    provider.listTasks(),
    provider.listReminders(),
  ]);
  const allIds = new Map<string, string>([
    ...result.taskIds.entries(),
    ...result.reminderIds.entries(),
  ]);
  const expectedState = remapIds(archive.state, allIds);
  if (!isDeepStrictEqual(state, expectedState)) {
    throw new Error("Restored assistant state does not match the backup.");
  }
  if (!isDeepStrictEqual(taskSignatures(tasks), taskSignatures(archive.tasks))) {
    throw new Error("Restored tasks do not match the backup.");
  }
  if (!isDeepStrictEqual(reminderSignatures(reminders), reminderSignatures(archive.reminders))) {
    throw new Error("Restored reminders do not match the backup.");
  }
}

export async function restoreBackupIntoEmptyProvider(
  provider: PersistenceProvider,
  archiveInput: BackupArchive,
): Promise<RestoreResult> {
  const archive = parseBackup(archiveInput);
  const [existingState, existingTasks, existingReminders] = await Promise.all([
    provider.loadState(),
    provider.listTasks(),
    provider.listReminders(),
  ]);
  if (
    Object.keys(existingState).length > 0 ||
    existingTasks.length > 0 ||
    existingReminders.length > 0
  ) {
    throw new Error("Restore refused: the target provider is not empty.");
  }

  const taskIds = new Map<string, string>();
  const reminderIds = new Map<string, string>();
  const createdTasks: string[] = [];
  const createdReminders: string[] = [];
  let stateWriteAttempted = false;

  try {
    for (const source of archive.tasks) {
      let restored = await provider.addTask(source.title, source.category);
      createdTasks.push(restored.id);
      taskIds.set(source.id, restored.id);
      if (source.completed) {
        const completed = await provider.completeTask(restored.id);
        if (!completed) throw new Error(`Failed to complete restored task: ${source.title}`);
        restored = completed;
      }
    }

    for (const source of archive.reminders) {
      const restored = await provider.addReminder(source.title, source.due);
      createdReminders.push(restored.id);
      reminderIds.set(source.id, restored.id);
    }

    const allIds = new Map<string, string>([...taskIds.entries(), ...reminderIds.entries()]);
    stateWriteAttempted = true;
    await provider.saveState(remapIds(archive.state, allIds) as AssistantState);

    const result: RestoreResult = {
      taskIds,
      reminderIds,
      taskCount: taskIds.size,
      reminderCount: reminderIds.size,
    };
    await assertRestoredBackup(provider, archive, result);
    return result;
  } catch (error: unknown) {
    const cleanupErrors: unknown[] = [];
    for (const id of [...createdReminders].reverse()) {
      await provider.removeReminder(id).catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
    }
    for (const id of [...createdTasks].reverse()) {
      await provider.removeTask(id).catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
    }
    if (stateWriteAttempted) {
      await provider.saveState({}).catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Restore failed and rollback was incomplete.");
    }
    throw error;
  }
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
