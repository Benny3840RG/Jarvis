import { ConvexHttpClient } from "convex/browser";

import {
  ConvexPersistence as CoreConvexPersistence,
  assistantStateFunctions,
  type AssistantState,
  type ConvexClientLike,
  type Reminder,
  type Task,
} from "./persistenceCore.js";
import type {
  PersistenceProvider,
  PersistenceRestoreResult,
  PersistenceSnapshot,
} from "./atomicTypes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export class ConvexPersistence extends CoreConvexPersistence implements PersistenceProvider {
  private readonly atomicClient: ConvexClientLike;
  private readonly atomicServiceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    super(client, serviceToken);
    this.atomicServiceToken = serviceToken as string;
    this.atomicClient =
      client ?? (new ConvexHttpClient(process.env.CONVEX_URL as string) as ConvexClientLike);
  }

  async snapshot(): Promise<PersistenceSnapshot> {
    const row = await this.atomicClient.query(assistantStateFunctions.snapshot, {
      serviceToken: this.atomicServiceToken,
    });
    return {
      state: isRecord(row.state) ? ({ ...row.state } as AssistantState) : {},
      tasks: row.tasks.map(taskFromConvex),
      reminders: row.reminders.map(reminderFromConvex),
    };
  }

  async restoreSnapshotIntoEmpty(snapshot: PersistenceSnapshot): Promise<PersistenceRestoreResult> {
    const row = await this.atomicClient.mutation(assistantStateFunctions.restoreEmpty, {
      serviceToken: this.atomicServiceToken,
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
