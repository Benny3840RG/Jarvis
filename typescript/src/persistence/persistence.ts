import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import { validateReminderDue, type ReminderDue } from "../reminders/due.js";
import {
  validateReminderUpdate,
  validateTaskUpdate,
  type ReminderUpdate,
  type TaskUpdate,
} from "./updates.js";

export type { ReminderDue, ReminderUpdate, TaskUpdate };

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
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
  createdAt: number;
};

export interface PersistenceProvider {
  loadState(): Promise<AssistantState>;
  saveState(state: AssistantState): Promise<void>;
  listTasks(): Promise<Task[]>;
  addTask(title: string, category: string): Promise<Task>;
  updateTask(id: string, update: TaskUpdate): Promise<Task | null>;
  completeTask(id: string): Promise<Task | null>;
  removeTask(id: string): Promise<Task | null>;
  listReminders(): Promise<Reminder[]>;
  addReminder(title: string, due?: ReminderDue): Promise<Reminder>;
  updateReminder(id: string, update: ReminderUpdate): Promise<Reminder | null>;
  removeReminder(id: string): Promise<Reminder | null>;
}

const DOCUMENT_VERSION = 2 as const;
const LEGACY_DOCUMENT_VERSION = 1 as const;
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

function normalizedDueFromRecord(value: Record<string, unknown>, index: number): Partial<Reminder> {
  if (
    value.dueRaw !== undefined &&
    (typeof value.dueRaw !== "string" || value.dueRaw.length === 0)
  ) {
    throw new StateDocumentError(`Reminder ${index} has an invalid dueRaw value.`);
  }
  if (
    value.dueAt !== undefined &&
    (typeof value.dueAt !== "number" || !Number.isFinite(value.dueAt))
  ) {
    throw new StateDocumentError(`Reminder ${index} has an invalid dueAt value.`);
  }
  if (
    value.dueTimezone !== undefined &&
    (typeof value.dueTimezone !== "string" || value.dueTimezone.length === 0)
  ) {
    throw new StateDocumentError(`Reminder ${index} has an invalid dueTimezone value.`);
  }
  if ((value.dueAt === undefined) !== (value.dueTimezone === undefined)) {
    throw new StateDocumentError(
      `Reminder ${index} must contain both dueAt and dueTimezone or neither value.`,
    );
  }
  if (value.dueAt !== undefined && value.dueRaw === undefined) {
    throw new StateDocumentError(`Reminder ${index} has a normalized due value without dueRaw.`);
  }
  return {
    ...(typeof value.dueRaw === "string" ? { dueRaw: value.dueRaw } : {}),
    ...(typeof value.dueAt === "number"
      ? { dueAt: value.dueAt, dueTimezone: value.dueTimezone as string }
      : {}),
  };
}

function normalizeReminder(
  value: unknown,
  index: number,
  format: "legacy" | "version1" | "version2",
): Reminder {
  if (!isRecord(value)) throw new StateDocumentError(`Reminder ${index} is not an object.`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new StateDocumentError(`Reminder ${index} has an invalid id.`);
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new StateDocumentError(`Reminder ${index} has an invalid title.`);
  }
  if (format !== "legacy" && typeof value.createdAt !== "number") {
    throw new StateDocumentError(`Reminder ${index} has an invalid createdAt value.`);
  }

  let due: Partial<Reminder> = {};
  if (format === "version2") {
    if (value.due !== undefined) {
      throw new StateDocumentError(`Reminder ${index} contains the retired due field.`);
    }
    due = normalizedDueFromRecord(value, index);
  } else {
    if (value.due !== undefined && typeof value.due !== "string") {
      throw new StateDocumentError(`Reminder ${index} has an invalid due value.`);
    }
    due = typeof value.due === "string" ? { dueRaw: value.due } : {};
  }

  return {
    id: value.id,
    title: value.title,
    ...due,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
  };
}

function normalizeRows<T>(
  value: unknown,
  name: string,
  normalize: (entry: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) throw new StateDocumentError(`${name} must be an array.`);
  return value.map(normalize);
}

export function normalizeDocument(value: unknown): PersistedDocument {
  if (!isRecord(value)) throw new StateDocumentError("State document must be an object.");

  if ("version" in value) {
    if (value.version !== DOCUMENT_VERSION && value.version !== LEGACY_DOCUMENT_VERSION) {
      throw new StateDocumentError(`Unsupported state document version: ${String(value.version)}.`);
    }
    if (!isRecord(value.state)) {
      throw new StateDocumentError(`Version ${String(value.version)} state must be an object.`);
    }
    const format = value.version === DOCUMENT_VERSION ? "version2" : "version1";
    return {
      version: DOCUMENT_VERSION,
      state: { ...value.state },
      tasks: normalizeRows(value.tasks, `Version ${String(value.version)} tasks`, (entry, index) =>
        normalizeTask(entry, index, true),
      ),
      reminders: normalizeRows(
        value.reminders,
        `Version ${String(value.version)} reminders`,
        (entry, index) => normalizeReminder(entry, index, format),
      ),
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
    tasks:
      value.tasks === undefined
        ? []
        : normalizeRows(value.tasks, "Legacy tasks", (entry, index) =>
            normalizeTask(entry, index, false),
          ),
    reminders:
      value.reminders === undefined
        ? []
        : normalizeRows(value.reminders, "Legacy reminders", (entry, index) =>
            normalizeReminder(entry, index, "legacy"),
          ),
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
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0)
    return null;
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
            : { dueAt: normalized.at, dueTimezone: normalized.timezone as string }),
        }),
    createdAt,
  };
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

  private async readLockState(): Promise<
    | { kind: "missing" }
    | { kind: "valid"; record: LockRecord }
    | { kind: "malformed"; modifiedAt: number; size: number; device: number; inode: number }
  > {
    let raw: string;
    try {
      raw = await fs.readFile(this.lockPath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
      throw error;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(this.lockPath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
      throw error;
    }

    try {
      const record = normalizeLockRecord(JSON.parse(raw) as unknown);
      if (record) return { kind: "valid", record };
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
    }

    return {
      kind: "malformed",
      modifiedAt: stat.mtimeMs,
      size: stat.size,
      device: stat.dev,
      inode: stat.ino,
    };
  }

  private async removeOwnedLock(token: string): Promise<boolean> {
    const state = await this.readLockState();
    if (state.kind === "missing") return true;
    if (state.kind !== "valid" || state.record.token !== token) return false;
    try {
      await fs.rm(this.lockPath);
      return true;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
  }

  private async reclaimStaleLock(): Promise<boolean> {
    const state = await this.readLockState();
    if (state.kind === "missing") return true;

    if (state.kind === "valid") {
      if (isProcessAlive(state.record.pid)) return false;
      if (!(await this.removeOwnedLock(state.record.token))) return false;
      this.warn(`Jarvis reclaimed a stale JSON state lock left by process ${state.record.pid}.`);
      return true;
    }

    const malformedGraceMs = Math.max(100, this.lockTimeoutMs);
    if (Date.now() - state.modifiedAt < malformedGraceMs) return false;

    const confirmed = await this.readLockState();
    if (
      confirmed.kind !== "malformed" ||
      confirmed.modifiedAt !== state.modifiedAt ||
      confirmed.size !== state.size ||
      confirmed.device !== state.device ||
      confirmed.inode !== state.inode
    ) {
      return confirmed.kind === "missing";
    }

    try {
      await fs.rm(this.lockPath);
      this.warn("Jarvis reclaimed a stale malformed JSON state lock.");
      return true;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
  }

  private async tryCreateWriteLock(record: LockRecord): Promise<boolean> {
    const tempPath = `${this.lockPath}.tmp-${process.pid}-${record.token}`;
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await fs.link(tempPath, this.lockPath);
        return true;
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === "EEXIST") return false;
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async acquireWriteLock(): Promise<LockRecord> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const startedAt = Date.now();
    const record: LockRecord = {
      pid: process.pid,
      acquiredAt: Date.now(),
      token: randomUUID(),
    };

    while (true) {
      if (await this.tryCreateWriteLock(record)) return record;
      if (await this.reclaimStaleLock()) continue;

      if (Date.now() - startedAt >= Math.max(0, this.lockTimeoutMs)) {
        const state = await this.readLockState();
        if (state.kind === "missing") continue;
        const owner =
          state.kind === "valid" ? `process ${state.record.pid}` : "a malformed lock file";
        throw new Error(
          `Jarvis JSON state is locked by ${owner}. Close the other local writer or select Convex for multi-process use.`,
        );
      }

      await delay(LOCK_RETRY_MS);
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireWriteLock();
    let failed = false;
    let primaryError: unknown;
    let result: T | undefined;

    try {
      result = await operation();
    } catch (error: unknown) {
      failed = true;
      primaryError = error;
    }

    let releaseError: unknown;
    try {
      if (!(await this.removeOwnedLock(lock.token))) {
        throw new Error("Jarvis JSON state lock ownership changed before release; lock left in place.");
      }
    } catch (error: unknown) {
      releaseError = error;
    }

    if (failed) {
      if (releaseError !== undefined) {
        throw new AggregateError(
          [primaryError, releaseError],
          "Jarvis JSON mutation failed and its state lock could not be released safely.",
        );
      }
      throw primaryError;
    }
    if (releaseError !== undefined) throw releaseError;
    return result as T;
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
        await this.writeDocument({ ...current, reminders: [...current.reminders, reminder] });
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
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
  createdAt: number;
}): Reminder {
  const dueRaw = row.dueRaw ?? row.due;
  const hasNormalized = row.dueAt !== undefined && row.dueTimezone !== undefined;
  return {
    id: row._id,
    title: row.title,
    ...(dueRaw === undefined ? {} : { dueRaw }),
    ...(hasNormalized ? { dueAt: row.dueAt, dueTimezone: row.dueTimezone } : {}),
    createdAt: row.createdAt,
  };
}

function isInvalidIdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:invalid|malformed)(?: convex)?(?: document)? id|not a valid(?: convex)? id|document id.*not found/i.test(message);
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
      throw new Error(
        "PERSISTENCE_PROVIDER=convex requires CONVEX_URL to be set in the environment.",
      );
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

  async updateTask(id: string, update: TaskUpdate): Promise<Task | null> {
    const validated = validateTaskUpdate(update);
    try {
      const row = await this.client.mutation(taskFunctions.update, {
        serviceToken: this.serviceToken,
        id,
        ...validated,
      });
      return row === null ? null : taskFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
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

  async addReminder(title: string, due?: ReminderDue): Promise<Reminder> {
    const normalized = due === undefined ? undefined : validateReminderDue(due);
    const row = await this.client.mutation(reminderFunctions.create, {
      serviceToken: this.serviceToken,
      title,
      ...(normalized === undefined
        ? {}
        : {
            dueRaw: normalized.raw,
            ...(normalized.at === undefined
              ? {}
              : { dueAt: normalized.at, dueTimezone: normalized.timezone as string }),
          }),
    });
    return reminderFromConvex(row);
  }

  async updateReminder(id: string, update: ReminderUpdate): Promise<Reminder | null> {
    const validated = validateReminderUpdate(update);
    const dueArgs =
      validated.due === undefined
        ? {}
        : validated.due === null
          ? { clearDue: true }
          : {
              dueRaw: validated.due.raw,
              ...(validated.due.at === undefined
                ? {}
                : {
                    dueAt: validated.due.at,
                    dueTimezone: validated.due.timezone as string,
                  }),
            };
    try {
      const row = await this.client.mutation(reminderFunctions.update, {
        serviceToken: this.serviceToken,
        id,
        ...(validated.title === undefined ? {} : { title: validated.title }),
        ...dueArgs,
      });
      return row === null ? null : reminderFromConvex(row);
    } catch (error: unknown) {
      if (isInvalidIdError(error)) return null;
      throw error;
    }
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
