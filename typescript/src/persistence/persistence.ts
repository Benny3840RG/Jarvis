import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";

export type AssistantState = {
  lastIntent?: string;
  lastInput?: string;
  lastResult?: unknown;
  lastReminder?: unknown;
  lastTask?: unknown;
  [key: string]: unknown;
};

export type Task = {
  id: string;
  title: string;
  completed: boolean;
  category: string;
  createdAt: number;
};

export type Reminder = {
  id: string;
  title: string;
  due?: string;
  createdAt: number;
};

export interface PersistenceProvider {
  loadState(): Promise<AssistantState>;
  saveState(state: AssistantState): Promise<void>;
  listTasks(): Promise<Task[]>;
  addTask(title: string, category: string): Promise<Task>;
  completeTask(id: string): Promise<Task | null>;
  removeTask(id: string): Promise<Task | null>;
  listReminders(): Promise<Reminder[]>;
  addReminder(title: string, due?: string): Promise<Reminder>;
  removeReminder(id: string): Promise<Reminder | null>;
}

const DOCUMENT_VERSION = 1 as const;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;

type PersistedDocument = {
  version: typeof DOCUMENT_VERSION;
  state: AssistantState;
  tasks: Task[];
  reminders: Reminder[];
};

type LockRecord = {
  pid: number;
  acquiredAt: number;
  token: string;
};

class StateDocumentError extends Error {}

function emptyDocument(): PersistedDocument {
  return { version: DOCUMENT_VERSION, state: {}, tasks: [], reminders: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneTask(task: Task): Task {
  return { ...task };
}

function cloneReminder(reminder: Reminder): Reminder {
  return { ...reminder };
}

function cloneDocument(document: PersistedDocument): PersistedDocument {
  return {
    version: DOCUMENT_VERSION,
    state: { ...document.state },
    tasks: document.tasks.map(cloneTask),
    reminders: document.reminders.map(cloneReminder),
  };
}

function normalizeTask(value: unknown, index: number, strict: boolean): Task {
  if (!isRecord(value)) throw new StateDocumentError(`Task ${index} is not an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new StateDocumentError(`Task ${index} has an invalid id.`);
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new StateDocumentError(`Task ${index} has an invalid title.`);
  }
  if (typeof value.completed !== "boolean") {
    throw new StateDocumentError(`Task ${index} has an invalid completed flag.`);
  }
  if (strict && typeof value.category !== "string") {
    throw new StateDocumentError(`Task ${index} has an invalid category.`);
  }
  if (strict && typeof value.createdAt !== "number") {
    throw new StateDocumentError(`Task ${index} has an invalid createdAt value.`);
  }
  return {
    id: value.id,
    title: value.title,
    completed: value.completed,
    category: typeof value.category === "string" ? value.category : "personal",
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
  };
}

function normalizeReminder(value: unknown, index: number, strict: boolean): Reminder {
  if (!isRecord(value)) throw new StateDocumentError(`Reminder ${index} is not an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new StateDocumentError(`Reminder ${index} has an invalid id.`);
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new StateDocumentError(`Reminder ${index} has an invalid title.`);
  }
  if (value.due !== undefined && typeof value.due !== "string") {
    throw new StateDocumentError(`Reminder ${index} has an invalid due value.`);
  }
  if (strict && typeof value.createdAt !== "number") {
    throw new StateDocumentError(`Reminder ${index} has an invalid createdAt value.`);
  }
  return {
    id: value.id,
    title: value.title,
    ...(typeof value.due === "string" ? { due: value.due } : {}),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
  };
}

function normalizeRows<T>(
  value: unknown,
  name: string,
  normalize: (entry: unknown, index: number, strict: boolean) => T,
  strict: boolean,
): T[] {
  if (!Array.isArray(value)) throw new StateDocumentError(`${name} must be an array.`);
  return value.map((entry, index) => normalize(entry, index, strict));
}

export function normalizeDocument(value: unknown): PersistedDocument {
  if (!isRecord(value)) throw new StateDocumentError("State document must be an object.");

  if ("version" in value) {
    if (value.version !== DOCUMENT_VERSION) {
      throw new StateDocumentError(`Unsupported state document version: ${String(value.version)}.`);
    }
    if (!isRecord(value.state)) throw new StateDocumentError("Version 1 state must be an object.");
    return {
      version: DOCUMENT_VERSION,
      state: { ...value.state },
      tasks: normalizeRows(value.tasks, "Version 1 tasks", normalizeTask, true),
      reminders: normalizeRows(value.reminders, "Version 1 reminders", normalizeReminder, true),
    };
  }

  const documentLike = "state" in value || "tasks" in value || "reminders" in value;
  if (!documentLike) {
    return { version: DOCUMENT_VERSION, state: { ...value }, tasks: [], reminders: [] };
  }

  if (value.state !== undefined && !isRecord(value.state)) {
    throw new StateDocumentError("Legacy state must be an object.");
  }
  return {
    version: DOCUMENT_VERSION,
    state: value.state === undefined ? {} : { ...value.state },
    tasks: value.tasks === undefined ? [] : normalizeRows(value.tasks, "Legacy tasks", normalizeTask, false),
    reminders:
      value.reminders === undefined
        ? []
        : normalizeRows(value.reminders, "Legacy reminders", normalizeReminder, false),
  };
}

export const assistantStateFunctions = api.assistantState;
export const taskFunctions = api.tasks;
export const reminderFunctions = api.reminders;

function defaultDataPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-state.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function normalizeLockRecord(value: unknown): LockRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.acquiredAt !== "number" || !Number.isFinite(value.acquiredAt)) return null;
  if (typeof value.token !== "string" || value.token.length === 0) return null;
  return {
    pid: value.pid,
    acquiredAt: value.acquiredAt,
    token: value.token,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    return true;
  }
}

export type PersistenceWarning = (message: string) => void;

export class JSONPersistence implements PersistenceProvider {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = defaultDataPath(),
    private readonly warn: PersistenceWarning = (message) => console.warn(message),
    private readonly lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  ) {}

  private get lockPath(): string {
    return `${this.filePath}.lock`;
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

  private async readLockRecord(): Promise<LockRecord | null> {
    try {
      const raw = await fs.readFile(this.lockPath, "utf8");
      return normalizeLockRecord(JSON.parse(raw) as unknown);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async reclaimDeadLock(): Promise<boolean> {
    const record = await this.readLockRecord();
    if (!record || isProcessAlive(record.pid)) return false;
    try {
      await fs.rm(this.lockPath);
      this.warn(`Jarvis reclaimed a stale JSON state lock left by process ${record.pid}.`);
      return true;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
  }

  private async acquireWriteLock(): Promise<FileHandle> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const startedAt = Date.now();

    while (true) {
      let handle: FileHandle | undefined;
      try {
        handle = await fs.open(this.lockPath, "wx", 0o600);
        const record: LockRecord = {
          pid: process.pid,
          acquiredAt: Date.now(),
          token: randomUUID(),
        };
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
        return handle;
      } catch (error: unknown) {
        await handle?.close().catch(() => undefined);
        if (!(isNodeError(error) && error.code === "EEXIST")) {
          await fs.rm(this.lockPath, { force: true }).catch(() => undefined);
          throw error;
        }
      }

      if (await this.reclaimDeadLock()) continue;

      if (Date.now() - startedAt >= Math.max(0, this.lockTimeoutMs)) {
        const record = await this.readLockRecord();
        const owner = record ? `process ${record.pid}` : "another process";
        throw new Error(
          `Jarvis JSON state is locked by ${owner}. Close the other local writer or select Convex for multi-process use.`,
        );
      }

      await delay(LOCK_RETRY_MS);
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const handle = await this.acquireWriteLock();
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await fs.rm(this.lockPath, { force: true });
    }
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
        await this.writeDocument({ ...current, tasks: [...current.tasks, task] });
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

  async addReminder(title: string, due?: string): Promise<Reminder> {
    return this.enqueue(() =>
      this.withWriteLock(async () => {
        const current = await this.readDocument();
        const reminder: Reminder = {
          id: randomUUID(),
          title,
          ...(due === undefined ? {} : { due }),
          createdAt: Date.now(),
        };
        await this.writeDocument({ ...current, reminders: [...current.reminders, reminder] });
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
}

export type ConvexClientLike = Pick<ConvexHttpClient, "query" | "mutation">;

function taskFromConvex(row: {
  _id: string;
  title: string;
  completed: boolean;
  category: string;
  createdAt: number;
}): Task {
  return {
    id: row._id,
    title: row.title,
    completed: row.completed,
    category: row.category,
    createdAt: row.createdAt,
  };
}

function reminderFromConvex(row: {
  _id: string;
  title: string;
  due?: string;
  createdAt: number;
}): Reminder {
  return {
    id: row._id,
    title: row.title,
    ...(row.due === undefined ? {} : { due: row.due }),
    createdAt: row.createdAt,
  };
}

function isInvalidIdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /argument validation|invalid(?: convex)? id|invalid id|document.*not found/i.test(message);
}

export class ConvexPersistence implements PersistenceProvider {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) {
      throw new Error(
        "PERSISTENCE_PROVIDER=convex requires JARVIS_SERVICE_TOKEN. The deployment URL is not authentication.",
      );
    }
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      throw new Error("PERSISTENCE_PROVIDER=convex requires CONVEX_URL to be set in the environment.");
    }
    this.client = new ConvexHttpClient(convexUrl);
  }

  async loadState(): Promise<AssistantState> {
    const row = await this.client.query(assistantStateFunctions.get, {
      serviceToken: this.serviceToken,
    });
    return row && isRecord(row.state) ? { ...row.state } : {};
  }

  async saveState(state: AssistantState): Promise<void> {
    await this.client.mutation(assistantStateFunctions.upsert, {
      serviceToken: this.serviceToken,
      state,
    });
  }

  async listTasks(): Promise<Task[]> {
    const rows = await this.client.query(taskFunctions.list, {
      serviceToken: this.serviceToken,
    });
    return rows.map(taskFromConvex);
  }

  async addTask(title: string, category: string): Promise<Task> {
    const row = await this.client.mutation(taskFunctions.create, {
      serviceToken: this.serviceToken,
      title,
      category,
    });
    return taskFromConvex(row);
  }

  async completeTask(id: string): Promise<Task | null> {
    try {
      const row = await this.client.mutation(taskFunctions.complete, {
        serviceToken: this.serviceToken,
        id,
      });
      return row === null ? null : taskFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }

  async removeTask(id: string): Promise<Task | null> {
    try {
      const row = await this.client.mutation(taskFunctions.remove, {
        serviceToken: this.serviceToken,
        id,
      });
      return row === null ? null : taskFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }

  async listReminders(): Promise<Reminder[]> {
    const rows = await this.client.query(reminderFunctions.list, {
      serviceToken: this.serviceToken,
    });
    return rows.map(reminderFromConvex);
  }

  async addReminder(title: string, due?: string): Promise<Reminder> {
    const row = await this.client.mutation(reminderFunctions.create, {
      serviceToken: this.serviceToken,
      title,
      ...(due === undefined ? {} : { due }),
    });
    return reminderFromConvex(row);
  }

  async removeReminder(id: string): Promise<Reminder | null> {
    try {
      const row = await this.client.mutation(reminderFunctions.remove, {
        serviceToken: this.serviceToken,
        id,
      });
      return row === null ? null : reminderFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
  }
}

export function createPersistenceFromEnv(client?: ConvexClientLike): PersistenceProvider {
  const provider = (process.env.PERSISTENCE_PROVIDER ?? "json").trim().toLowerCase();
  if (provider === "" || provider === "json") return new JSONPersistence();
  if (provider === "convex") return new ConvexPersistence(client);
  throw new Error(
    `Invalid PERSISTENCE_PROVIDER '${process.env.PERSISTENCE_PROVIDER}'. Valid values: unset, json, convex.`,
  );
}
