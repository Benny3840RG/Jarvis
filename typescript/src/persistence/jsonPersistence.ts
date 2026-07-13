import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { validateReminderDue, type ReminderDue } from "../reminders/due.js";
import {
  DOCUMENT_VERSION,
  emptyDocument,
  cloneDocument,
  cloneReminder,
  cloneTask,
  normalizeDocument,
  StateDocumentError,
  type PersistedDocument,
} from "./document.js";
import { JsonFileLock } from "./jsonFileLock.js";
import type {
  AssistantState,
  PersistenceProvider,
  PersistenceRestoreResult,
  PersistenceSnapshot,
  PersistenceWarning,
  Reminder,
  Task,
} from "./types.js";
import {
  validateReminderUpdate,
  validateTaskUpdate,
  type ReminderUpdate,
  type TaskUpdate,
} from "./updates.js";

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

function defaultDataPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-state.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function reminderFromDue(
  id: string,
  title: string,
  createdAt: number,
  due?: ReminderDue,
): Reminder {
  const normalized = due === undefined ? undefined : validateReminderDue(due);
  return {
    id,
    title,
    ...(normalized === undefined
      ? {}
      : {
          dueRaw: normalized.raw,
          ...(normalized.at === undefined
            ? {}
            : {
                dueAt: normalized.at,
                dueTimezone: normalized.timezone as string,
              }),
        }),
    createdAt,
  };
}

function snapshotFromDocument(document: PersistedDocument): PersistenceSnapshot {
  return {
    state: { ...document.state },
    tasks: document.tasks.map(cloneTask),
    reminders: document.reminders.map(cloneReminder),
  };
}

function remapIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => remapIds(entry, ids));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, remapIds(entry, ids)]),
    );
  }
  return value;
}

function reminderDue(reminder: Reminder): ReminderDue | undefined {
  if (reminder.dueRaw === undefined) return undefined;
  return {
    raw: reminder.dueRaw,
    ...(reminder.dueAt === undefined
      ? {}
      : { at: reminder.dueAt, timezone: reminder.dueTimezone as string }),
  };
}

function restoredReminder(id: string, reminder: Reminder): Reminder {
  const due = reminderDue(reminder);
  return {
    id,
    title: reminder.title,
    ...(due === undefined
      ? {}
      : {
          dueRaw: due.raw,
          ...(due.at === undefined ? {} : { dueAt: due.at, dueTimezone: due.timezone as string }),
        }),
    createdAt: Date.now(),
  };
}

export class JSONPersistence implements PersistenceProvider {
  private pending: Promise<void> = Promise.resolve();
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath = defaultDataPath(),
    private readonly warn: PersistenceWarning = (message) => console.warn(message),
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async quarantine(error: unknown): Promise<void> {
    const suffix = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const corruptPath = `${this.filePath}.corrupt-${suffix}`;
    try {
      await fs.rename(this.filePath, corruptPath);
      const message = error instanceof Error ? error.message : String(error);
      this.warn(`Jarvis state file was corrupt and has been moved to ${corruptPath}: ${message}`);
    } catch (renameError: unknown) {
      if (isNodeError(renameError) && renameError.code === "ENOENT") return;
      throw renameError;
    }
  }

  private async readFromDisk(): Promise<PersistedDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyDocument();
      throw error;
    }

    try {
      return normalizeDocument(JSON.parse(raw) as unknown);
    } catch (error: unknown) {
      const documentError =
        error instanceof StateDocumentError
          ? error
          : new StateDocumentError(
              `Malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
            );
      await this.quarantine(documentError);
      return emptyDocument();
    }
  }

  private async readDocument(): Promise<PersistedDocument> {
    return cloneDocument(await this.readFromDisk());
  }

  private async writeDocument(document: PersistedDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.tmp-${process.pid}-${randomUUID()}`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tempPath, this.filePath);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.writeLock.run(operation, "mutation");
  }

  async loadState(): Promise<AssistantState> {
    return this.enqueue(async () => ({ ...(await this.readDocument()).state }));
  }

  async saveState(state: AssistantState): Promise<void> {
    await this.enqueue(() =>
      this.withWriteLock(async () => {
        const current = await this.readDocument();
        await this.writeDocument({ ...current, state: { ...state } });
      }),
    );
  }

  async listTasks(): Promise<Task[]> {
    return this.enqueue(async () => (await this.readDocument()).tasks.map(cloneTask));
  }

  async addTask(title: string, category: string): Promise<Task> {
    return this.enqueue(() =>
      this.withWriteLock(async () => {
        const current = await this.readDocument();
        const task: Task = {
          id: randomUUID(),
          title,
          completed: false,
          category,
          createdAt: Date.now(),
        };
        await this.writeDocument({
          ...current,
          tasks: [...current.tasks, task],
        });
        return cloneTask(task);
      }),
    );
  }

  async updateTask(id: string, update: TaskUpdate): Promise<Task | null> {
    const validated = validateTaskUpdate(update);
    return this.enqueue(() =>
      this.withWriteLock(async () => {
        const current = await this.readDocument();
        const index = current.tasks.findIndex((task) => task.id === id);
        if (index < 0) return null;
        const task: Task = { ...current.tasks[index], ...validated };
        const tasks = current.tasks.map((entry, taskIndex) => (taskIndex === index ? task : entry));
        await this.writeDocument({ ...current, tasks });
        return cloneTask(task);
      }),
    );
  }

  async completeTask(id: string): Promise<Task | null> {
    return this.enqueue(() =>
      this.withWriteLock(async () => {
        const current = await this.readDocument();
        const index = current.tasks.findIndex((task) => task.id === id);
        if (index < 0) return null;
        const task = { ...current.tasks[index], completed: true };
        const tasks = current.tasks.map((entry, taskIndex) => (taskIndex === index ? task : entry));
        await this.writeDocument({ ...current, tasks });
        return cloneTask(task);
      }),
    );
  }

  async removeTask(id: string): Promise<Task | null> {
    return this.enqueue(() =>
      this.withWriteLock(async () => {
        const current = await this.readDocument();
        const task = current.tasks.find((entry) => entry.id === id);
        if (!task) return null;
        await this.writeDocument({
          ...current,
          tasks: current.tasks.filter((entry) => entry.id !== id),
        });
        return cloneTask(task);
      }),
    );
  }

  async listReminders(): Promise<Reminder[]> {
    return this.enqueue(async () => (await this.readDocument()).reminders.map(cloneReminder));
  }

  async addReminder(title: string, due?: ReminderDue): Promise<Reminder> {
    return this.enqueue(() =>
      this.withWriteLock(async () => {
        const current = await this.readDocument();
        const reminder = reminderFromDue(randomUUID(), title, Date.now(), due);
        await this.writeDocument({
          ...current,
          reminders: [...current.reminders, reminder],
        });
        return cloneReminder(reminder);
      }),
    );
  }

  async updateReminder(id: string, update: ReminderUpdate): Promise<Reminder | null> {
    const validated = validateReminderUpdate(update);
    return this.enqueue(() =>
      this.withWriteLock(async () => {
        const current = await this.readDocument();
        const index = current.reminders.findIndex((reminder) => reminder.id === id);
        if (index < 0) return null;
        const existing = current.reminders[index];
        const title = validated.title ?? existing.title;
        let reminder: Reminder;
        if (validated.due === undefined) {
          reminder = { ...existing, title };
        } else if (validated.due === null) {
          reminder = { id: existing.id, title, createdAt: existing.createdAt };
        } else {
          reminder = reminderFromDue(existing.id, title, existing.createdAt, validated.due);
        }
        const reminders = current.reminders.map((entry, reminderIndex) =>
          reminderIndex === index ? reminder : entry,
        );
        await this.writeDocument({ ...current, reminders });
        return cloneReminder(reminder);
      }),
    );
  }

  async removeReminder(id: string): Promise<Reminder | null> {
    return this.enqueue(() =>
      this.withWriteLock(async () => {
        const current = await this.readDocument();
        const reminder = current.reminders.find((entry) => entry.id === id);
        if (!reminder) return null;
        await this.writeDocument({
          ...current,
          reminders: current.reminders.filter((entry) => entry.id !== id),
        });
        return cloneReminder(reminder);
      }),
    );
  }

  async snapshot(): Promise<PersistenceSnapshot> {
    return this.enqueue(() =>
      this.writeLock.run(async () => snapshotFromDocument(await this.readDocument())),
    );
  }

  async restoreSnapshotIntoEmpty(snapshot: PersistenceSnapshot): Promise<PersistenceRestoreResult> {
    const source = normalizeDocument({
      version: DOCUMENT_VERSION,
      state: snapshot.state,
      tasks: snapshot.tasks,
      reminders: snapshot.reminders,
    });

    return this.enqueue(() =>
      this.writeLock.run(async () => {
        const current = await this.readDocument();
        if (
          Object.keys(current.state).length > 0 ||
          current.tasks.length > 0 ||
          current.reminders.length > 0
        ) {
          throw new Error("Restore refused: the target provider is not empty.");
        }

        const taskIds = new Map<string, string>();
        const reminderIds = new Map<string, string>();
        const tasks = source.tasks.map((task) => {
          const id = randomUUID();
          taskIds.set(task.id, id);
          return {
            id,
            title: task.title,
            completed: task.completed,
            category: task.category,
            createdAt: Date.now(),
          };
        });
        const reminders = source.reminders.map((reminder) => {
          const id = randomUUID();
          reminderIds.set(reminder.id, id);
          return restoredReminder(id, reminder);
        });
        const allIds = new Map<string, string>([...taskIds.entries(), ...reminderIds.entries()]);
        const state = remapIds(source.state, allIds) as AssistantState;
        const restoredDocument: PersistedDocument = {
          version: DOCUMENT_VERSION,
          state,
          tasks,
          reminders,
        };
        await this.writeDocument(restoredDocument);
        return {
          snapshot: snapshotFromDocument(restoredDocument),
          taskIds,
          reminderIds,
        };
      }),
    );
  }
}
