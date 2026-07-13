import { randomUUID } from "node:crypto";

import type { PersistenceProvider } from "../persistence/persistence.js";

export type ConvexSmokeResult = {
  marker: string;
  taskCreated: boolean;
  taskCompleted: boolean;
  taskRemoved: boolean;
  reminderCreated: boolean;
  reminderRemoved: boolean;
  restartVisibilityVerified: boolean;
};

export type PersistenceFactory = () => PersistenceProvider;
export type SmokeWriter = (message: string) => void;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function redactSecret(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  if (!secret) return message;
  return message.split(secret).join("[REDACTED]");
}

export async function runConvexSmoke(
  createProvider: PersistenceFactory,
  deployment: string | undefined,
  write: SmokeWriter = (message) => console.log(message),
): Promise<ConvexSmokeResult> {
  if (!deployment?.trim().startsWith("dev:")) {
    throw new Error(
      "Convex smoke test refused: CONVEX_DEPLOYMENT must identify a development deployment (dev:...).",
    );
  }

  const marker = `jarvis-smoke-${randomUUID()}`;
  let taskId: string | undefined;
  let reminderId: string | undefined;
  let primaryError: unknown;

  try {
    const firstRun = createProvider();
    const task = await firstRun.addTask(`${marker} task`, "smoke");
    taskId = task.id;
    const reminder = await firstRun.addReminder(`${marker} reminder`, { raw: marker });
    reminderId = reminder.id;

    const createdTasks = await firstRun.listTasks();
    const createdReminders = await firstRun.listReminders();
    requireCondition(createdTasks.some((entry) => entry.id === task.id), "Created task was not listed.");
    requireCondition(
      createdReminders.some((entry) => entry.id === reminder.id && entry.dueRaw === marker),
      "Created reminder or its preserved due text was not listed.",
    );

    const restartedRun = createProvider();
    const restoredTasks = await restartedRun.listTasks();
    const restoredReminders = await restartedRun.listReminders();
    requireCondition(
      restoredTasks.some((entry) => entry.id === task.id),
      "Task was not visible from a new provider instance.",
    );
    requireCondition(
      restoredReminders.some((entry) => entry.id === reminder.id && entry.dueRaw === marker),
      "Reminder was not visible from a new provider instance with its due text intact.",
    );

    const completed = await restartedRun.completeTask(task.id);
    requireCondition(completed?.completed === true, "Task completion was not persisted.");

    const verificationRun = createProvider();
    const completedTasks = await verificationRun.listTasks();
    requireCondition(
      completedTasks.some((entry) => entry.id === task.id && entry.completed),
      "Completed task was not visible from a later provider instance.",
    );

    const removedReminder = await verificationRun.removeReminder(reminder.id);
    requireCondition(removedReminder?.id === reminder.id, "Reminder removal did not return the record.");
    reminderId = undefined;

    const removedTask = await verificationRun.removeTask(task.id);
    requireCondition(removedTask?.id === task.id, "Task removal did not return the record.");
    taskId = undefined;

    const finalRun = createProvider();
    const remainingTasks = await finalRun.listTasks();
    const remainingReminders = await finalRun.listReminders();
    requireCondition(
      !remainingTasks.some((entry) => entry.id === task.id),
      "Smoke-test task remained after cleanup.",
    );
    requireCondition(
      !remainingReminders.some((entry) => entry.id === reminder.id),
      "Smoke-test reminder remained after cleanup.",
    );

    const result: ConvexSmokeResult = {
      marker,
      taskCreated: true,
      taskCompleted: true,
      taskRemoved: true,
      reminderCreated: true,
      reminderRemoved: true,
      restartVisibilityVerified: true,
    };
    write("Convex smoke passed: create, list, restart visibility, complete, remove, and cleanup verified.");
    return result;
  } catch (error: unknown) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (taskId !== undefined || reminderId !== undefined) {
      try {
        const cleanup = createProvider();
        if (reminderId !== undefined) {
          await cleanup.removeReminder(reminderId).catch((error: unknown) => cleanupErrors.push(error));
        }
        if (taskId !== undefined) {
          await cleanup.removeTask(taskId).catch((error: unknown) => cleanupErrors.push(error));
        }
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
        "Convex smoke test cleanup failed.",
      );
    }
  }
}
