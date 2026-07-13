import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  JSONPersistence as CoreJSONPersistence,
  normalizeDocument,
  type AssistantState,
  type PersistenceWarning,
  type Reminder,
  type ReminderDue,
  type Task,
} from "./persistenceCore.js";
import { JsonFileLock } from "./jsonFileLock.js";
import type {
  PersistenceProvider,
  PersistenceRestoreResult,
  PersistenceSnapshot,
} from "./atomicTypes.js";

const DOCUMENT_VERSION = 2 as const;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

type PersistedDocument = {
  version: typeof DOCUMENT_VERSION;
  state: AssistantState;
  tasks: Task[];
  reminders: Reminder[];
};

function defaultDataPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-state.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function snapshotFromDocument(document: PersistedDocument): PersistenceSnapshot {
  return {
    state: { ...document.state },
    tasks: document.tasks.map((task) => ({ ...task })),
    reminders: document.reminders.map((reminder) => ({ ...reminder })),
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

export class JSONPersistence extends CoreJSONPersistence implements PersistenceProvider {
  private readonly lock: JsonFileLock;

  constructor(
    private readonly atomicFilePath = defaultDataPath(),
    private readonly atomicWarn: PersistenceWarning = (message) => console.warn(message),
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  ) {
    super(atomicFilePath, atomicWarn, lockTimeoutMs);
    this.lock = new JsonFileLock(atomicFilePath, atomicWarn, lockTimeoutMs);
  }

  private async quarantineAtomic(error: unknown): Promise<void> {
    const suffix = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const corruptPath = `${this.atomicFilePath}.corrupt-${suffix}`;
    try {
      await fs.rename(this.atomicFilePath, corruptPath);
      const message = error instanceof Error ? error.message : String(error);
      this.atomicWarn(
        `Jarvis state file was corrupt and has been moved to ${corruptPath}: ${message}`,
      );
    } catch (renameError: unknown) {
      if (isNodeError(renameError) && renameError.code === "ENOENT") return;
      throw renameError;
    }
  }

  private async readAtomicDocument(): Promise<PersistedDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.atomicFilePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: DOCUMENT_VERSION, state: {}, tasks: [], reminders: [] };
      }
      throw error;
    }

    try {
      return normalizeDocument(JSON.parse(raw) as unknown) as PersistedDocument;
    } catch (error: unknown) {
      await this.quarantineAtomic(error);
      return { version: DOCUMENT_VERSION, state: {}, tasks: [], reminders: [] };
    }
  }

  private async writeAtomicDocument(document: PersistedDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.atomicFilePath), { recursive: true });
    const tempPath = path.join(
      path.dirname(this.atomicFilePath),
      `.${path.basename(this.atomicFilePath)}.tmp-${process.pid}-${randomUUID()}`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tempPath, this.atomicFilePath);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async snapshot(): Promise<PersistenceSnapshot> {
    return this.lock.run(async () => snapshotFromDocument(await this.readAtomicDocument()));
  }

  async restoreSnapshotIntoEmpty(snapshot: PersistenceSnapshot): Promise<PersistenceRestoreResult> {
    const source = normalizeDocument({
      version: DOCUMENT_VERSION,
      state: snapshot.state,
      tasks: snapshot.tasks,
      reminders: snapshot.reminders,
    }) as PersistedDocument;

    return this.lock.run(async () => {
      const current = await this.readAtomicDocument();
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
      await this.writeAtomicDocument(restoredDocument);
      return {
        snapshot: snapshotFromDocument(restoredDocument),
        taskIds,
        reminderIds,
      };
    });
  }
}
