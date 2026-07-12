import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

import type { Reminder } from "../runtime/reminderService.js";
import type { Task } from "../runtime/taskService.js";

export type AssistantState = {
  lastIntent?: string;
  lastInput?: string;
  lastResult?: unknown;
  lastReminder?: unknown;
  lastTask?: unknown;
  [key: string]: unknown;
};

export interface PersistenceProvider {
  loadState(): Promise<AssistantState>;
  saveState(state: AssistantState): Promise<void>;
  listTasks(): Promise<Task[]>;
  addTask(title: string, category: string): Promise<Task>;
  completeTask(id: string): Promise<Task | null>;
  listReminders(): Promise<Reminder[]>;
  addReminder(title: string, due?: string): Promise<Reminder>;
  removeReminder(id: string): Promise<boolean>;
}

export const assistantStateFunctions = {
  get: anyApi.assistantState.get,
  upsert: anyApi.assistantState.upsert,
};

export const taskFunctions = {
  create: anyApi.tasks.create,
  list: anyApi.tasks.list,
  update: anyApi.tasks.update,
};

export const reminderFunctions = {
  create: anyApi.reminders.create,
  list: anyApi.reminders.list,
  remove: anyApi.reminders.remove,
};

type JSONDocument = {
  version: 1;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTask(value: unknown): value is Task {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.completed === "boolean" &&
    typeof value.category === "string"
  );
}

function isReminder(value: unknown): value is Reminder {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.due === undefined || typeof value.due === "string")
  );
}

function emptyDocument(): JSONDocument {
  return { version: 1, state: {}, tasks: [], reminders: [] };
}

function normalizeDocument(value: unknown): JSONDocument {
  if (isRecord(value) && value.version === 1 && isRecord(value.state)) {
    return {
      version: 1,
      state: value.state as AssistantState,
      tasks: Array.isArray(value.tasks) ? value.tasks.filter(isTask) : [],
      reminders: Array.isArray(value.reminders) ? value.reminders.filter(isReminder) : [],
    };
  }

  return {
    version: 1,
    state: isRecord(value) ? (value as AssistantState) : {},
    tasks: [],
    reminders: [],
  };
}

export class JSONPersistence implements PersistenceProvider {
  constructor(private readonly filePath = defaultDataPath()) {}

  private async readDocument(): Promise<JSONDocument> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      try {
        return normalizeDocument(JSON.parse(raw));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Malformed JSON in state file ${this.filePath}: ${message}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyDocument();
      throw error;
    }
  }

  private async writeDocument(document: JSONDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), "utf8");
  }

  async loadState(): Promise<AssistantState> {
    return (await this.readDocument()).state;
  }

  async saveState(state: AssistantState): Promise<void> {
    const document = await this.readDocument();
    await this.writeDocument({ ...document, state });
  }

  async listTasks(): Promise<Task[]> {
    return (await this.readDocument()).tasks.map((task) => ({ ...task }));
  }

  async addTask(title: string, category: string): Promise<Task> {
    const document = await this.readDocument();
    const task: Task = { id: randomUUID(), title, category, completed: false };
    document.tasks.push(task);
    await this.writeDocument(document);
    return { ...task };
  }

  async completeTask(id: string): Promise<Task | null> {
    const document = await this.readDocument();
    const task = document.tasks.find((entry) => entry.id === id);
    if (!task) return null;
    task.completed = true;
    await this.writeDocument(document);
    return { ...task };
  }

  async listReminders(): Promise<Reminder[]> {
    return (await this.readDocument()).reminders.map((reminder) => ({ ...reminder }));
  }

  async addReminder(title: string, due?: string): Promise<Reminder> {
    const document = await this.readDocument();
    const reminder: Reminder = { id: randomUUID(), title, due };
    document.reminders.push(reminder);
    await this.writeDocument(document);
    return { ...reminder };
  }

  async removeReminder(id: string): Promise<boolean> {
    const document = await this.readDocument();
    const next = document.reminders.filter((entry) => entry.id !== id);
    if (next.length === document.reminders.length) return false;
    document.reminders = next;
    await this.writeDocument(document);
    return true;
  }
}

export interface ConvexClientLike {
  query<T>(functionReference: unknown, args?: Record<string, unknown>): Promise<T>;
  mutation<T>(functionReference: unknown, args: Record<string, unknown>): Promise<T>;
}

type ConvexTaskRow = {
  _id: unknown;
  title: string;
  completed: boolean;
  category?: string;
};

type ConvexReminderRow = {
  _id: unknown;
  title: string;
  due?: string;
};

function taskFromRow(row: ConvexTaskRow): Task {
  return {
    id: String(row._id),
    title: row.title,
    completed: row.completed,
    category: row.category ?? "personal",
  };
}

function reminderFromRow(row: ConvexReminderRow): Reminder {
  return { id: String(row._id), title: row.title, due: row.due };
}

export class ConvexPersistence implements PersistenceProvider {
  private readonly client: ConvexClientLike;

  constructor(client?: ConvexClientLike) {
    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      throw new Error("PERSISTENCE_PROVIDER=convex requires CONVEX_URL to be set in the environment.");
    }
    this.client = new ConvexHttpClient(convexUrl) as unknown as ConvexClientLike;
  }

  async loadState(): Promise<AssistantState> {
    const row = await this.client.query<{ state?: AssistantState } | null>(
      assistantStateFunctions.get,
      {},
    );
    return row?.state ?? {};
  }

  async saveState(state: AssistantState): Promise<void> {
    await this.client.mutation(assistantStateFunctions.upsert, { state });
  }

  async listTasks(): Promise<Task[]> {
    const rows = await this.client.query<ConvexTaskRow[]>(taskFunctions.list, {});
    return rows.map(taskFromRow);
  }

  async addTask(title: string, category: string): Promise<Task> {
    const row = await this.client.mutation<ConvexTaskRow>(taskFunctions.create, { title, category });
    return taskFromRow(row);
  }

  async completeTask(id: string): Promise<Task | null> {
    const row = await this.client.mutation<ConvexTaskRow | null>(taskFunctions.update, {
      id,
      completed: true,
    });
    return row ? taskFromRow(row) : null;
  }

  async listReminders(): Promise<Reminder[]> {
    const rows = await this.client.query<ConvexReminderRow[]>(reminderFunctions.list, {});
    return rows.map(reminderFromRow);
  }

  async addReminder(title: string, due?: string): Promise<Reminder> {
    const row = await this.client.mutation<ConvexReminderRow>(reminderFunctions.create, {
      title,
      due,
    });
    return reminderFromRow(row);
  }

  async removeReminder(id: string): Promise<boolean> {
    return this.client.mutation<boolean>(reminderFunctions.remove, { id });
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
