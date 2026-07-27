import type { AssistantState, Reminder, Task } from "./types.js";

export const DOCUMENT_VERSION = 2 as const;
const LEGACY_DOCUMENT_VERSION = 1 as const;

export type PersistedDocument = {
  version: typeof DOCUMENT_VERSION;
  state: AssistantState;
  tasks: Task[];
  reminders: Reminder[];
};

export class StateDocumentError extends Error {}

export function emptyDocument(): PersistedDocument {
  return { version: DOCUMENT_VERSION, state: {}, tasks: [], reminders: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneTask(task: Task): Task {
  return { ...task };
}

export function cloneReminder(reminder: Reminder): Reminder {
  return { ...reminder };
}

export function cloneDocument(document: PersistedDocument): PersistedDocument {
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

  let due: Partial<Reminder>;
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
    return {
      version: DOCUMENT_VERSION,
      state: { ...value },
      tasks: [],
      reminders: [],
    };
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
