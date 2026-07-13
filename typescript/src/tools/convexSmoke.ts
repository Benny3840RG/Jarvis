import { randomUUID } from "node:crypto";

import type { PersistenceProvider } from "../persistence/persistence.js";

export type ConvexSmokeResult = {
  marker: string;
  taskCreated: boolean;
  taskUpdated: boolean;
  taskCompleted: boolean;
  taskRemoved: boolean;
  reminderCreated: boolean;
  reminderUpdated: boolean;
  reminderRemoved: boolean;
  restartVisibilityVerified: boolean;
};

export type PersistenceFactory = () => PersistenceProvider;
export type SmokeWriter = (message: string) => void;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function redactSecret(error: unknown, secret?: string): string {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (!secret) return message;
  return message.split(secret).join("[REDACTED]");
}

async function cleanupSmokeRecords(
  createProvider: PersistenceFactory,
  taskId: string | undefined,
  reminderId: string | undefined,
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  if (taskId === undefined && reminderId === undefined) return cleanupErrors;

  try {
    const cleanup = createProvider();
    if (reminderId !== undefined) {
      await cleanup
        .removeReminder(reminderId)
        .catch((error: unknown) => cleanupErrors.push(error));
    }
    if (taskId !== undefined) {
      await cleanup.removeTask(taskId).catch((error: unknown) => cleanupErrors.push(error));
    }
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  return cleanupErrors;
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
  const updatedTaskTitle = `${marker} task updated`;
  const updatedReminderTitle = `${marker} reminder updated`;
  const updatedDueRaw = `${marker} due updated`;
  let taskId: string | undefined;
  let reminderId: string | undefined;
  let primaryError: Error | undefined;
  let result: ConvexSmokeResult | undefined;

  try {
    const firstRun = createProvider();
    const task = await firstRun.addTask(`${marker} task`, "smoke");
    taskId = task.id;
    const reminder = await firstRun.addReminder(`${marker} reminder`, { raw: marker });
    reminderId = reminder.id;

    const updatedTask = await firstRun.updateTask(task.id, {
      title: updatedTaskTitle,
      category: "smoke-updated",
    });
    requireCondition(
      updatedTask?.title === updatedTaskTitle && updatedTask.category === "smoke-updated",
      "Task update did not return the updated record.",
    );
    const updatedReminder = await firstRun.updateReminder(reminder.id, {
      title: updatedReminderTitle,
      due: { raw: updatedDueRaw },
    });
    requireCondition(
      updatedReminder?.title === updatedReminderTitle && updatedReminder.dueRaw === updatedDueRaw,
      "Reminder update did not return the updated record.",
    );

    const createdTasks = await firstRun.listTasks();
    const createdReminders = await firstRun.listReminders();
    requireCondition(
      createdTasks.some(
        (entry) =>
          entry.id === task.id &&
          entry.title === updatedTaskTitle &&
          entry.category === "smoke-updated",
      ),
      "Updated task was not listed.",
    );
    requireCondition(
      createdReminders.some(
        (entry) =>
          entry.id === reminder.id &&
          entry.title === updatedReminderTitle &&
          entry.dueRaw === updatedDueRaw,
      ),
      "Updated reminder was not listed.",
    );

    const restartedRun = createProvider();
    const restoredTasks = await restartedRun.listTasks();
    const restoredReminders = await restartedRun.listReminders();
    requireCondition(
      restoredTasks.some(
        (entry) =>
          entry.id === task.id &&
          entry.title === updatedTaskTitle &&
          entry.category === "smoke-updated",
      ),
      "Updated task was not visible from a new provider instance.",
    );
    requireCondition(
      restoredReminders.some(
        (entry) =>
          entry.id === reminder.id &&
          entry.title === updatedReminderTitle &&
          entry.dueRaw === updatedDueRaw,
      ),
      "Updated reminder was not visible from a new provider instance.",
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
    requireCondition(
      removedReminder?.id === reminder.id,
      "Reminder removal did not return the record.",
    );
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

    result = {
      marker,
      taskCreated: true,
      taskUpdated: true,
      taskCompleted: true,
      taskRemoved: true,
      reminderCreated: true,
      reminderUpdated: true,
      reminderRemoved: true,
      restartVisibilityVerified: true,
    };
  } catch (error: unknown) {
    primaryError = normalizeError(error);
  }

  const cleanupErrors = await cleanupSmokeRecords(createProvider, taskId, reminderId);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      "Convex smoke test cleanup failed.",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  requireCondition(result !== undefined, "Convex smoke test finished without a result.");

  write(
    "Convex smoke passed: create, update, list, restart visibility, complete, remove, and cleanup verified.",
  );
  return result;
}
