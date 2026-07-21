import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import { validateReminderDue, type ReminderDue } from "../reminders/due.js";
import type {
  AssistantState,
  PersistenceProvider,
  PersistenceRestoreResult,
  PersistenceSnapshot,
  Reminder,
  Task,
} from "./types.js";
import {
  validateReminderUpdate,
  validateTaskUpdate,
  type ReminderUpdate,
  type TaskUpdate,
} from "./updates.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const assistantStateFunctions = api.assistantState;
export const taskFunctions = api.tasks;
export const reminderFunctions = api.reminders;

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

export function isInvalidIdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:invalid|malformed)(?: convex)?(?: document)? id|not a valid(?: convex)? id|document id.*not found/i.test(
    message,
  );
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
              : {
                  dueAt: normalized.at,
                  dueTimezone: normalized.timezone as string,
                }),
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

  async snapshot(): Promise<PersistenceSnapshot> {
    const row = await this.client.query(assistantStateFunctions.snapshot, {
      serviceToken: this.serviceToken,
    });
    return {
      state: isRecord(row.state) ? ({ ...row.state } as AssistantState) : {},
      tasks: row.tasks.map(taskFromConvex),
      reminders: row.reminders.map(reminderFromConvex),
    };
  }

  async restoreSnapshotIntoEmpty(snapshot: PersistenceSnapshot): Promise<PersistenceRestoreResult> {
    const row = await this.client.mutation(assistantStateFunctions.restoreEmpty, {
      serviceToken: this.serviceToken,
      state: snapshot.state,
      tasks: snapshot.tasks.map((task) => ({
        sourceId: task.id,
        title: task.title,
        completed: task.completed,
        category: task.category,
      })),
      reminders: snapshot.reminders.map((reminder) => ({
        sourceId: reminder.id,
        title: reminder.title,
        ...(reminder.dueRaw === undefined ? {} : { dueRaw: reminder.dueRaw }),
        ...(reminder.dueAt === undefined
          ? {}
          : {
              dueAt: reminder.dueAt,
              dueTimezone: reminder.dueTimezone as string,
            }),
      })),
    });
    return {
      snapshot: {
        state: isRecord(row.state) ? ({ ...row.state } as AssistantState) : {},
        tasks: row.tasks.map(taskFromConvex),
        reminders: row.reminders.map(reminderFromConvex),
      },
      taskIds: new Map(row.taskIds.map(({ sourceId, targetId }) => [sourceId, targetId])),
      reminderIds: new Map(row.reminderIds.map(({ sourceId, targetId }) => [sourceId, targetId])),
    };
  }
}
