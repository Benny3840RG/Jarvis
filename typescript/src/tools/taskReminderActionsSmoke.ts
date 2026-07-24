import { randomUUID } from "node:crypto";

import type { ControlledReminderRecord, ControlledReminderStore } from "../reminders/controlledReminder.js";
import type { ControlledTaskRecord, ControlledTaskStore } from "../tasks/controlledTask.js";
import type { SmokeWriter } from "./convexSmoke.js";

export type TaskReminderActionsSmokeResult = {
  taskCreated: boolean;
  taskReplayed: boolean;
  taskRestartVisible: boolean;
  taskCompleted: boolean;
  taskCompletionReplayed: boolean;
  reminderCreated: boolean;
  reminderReplayed: boolean;
  reminderRestartVisible: boolean;
  reminderCancelled: boolean;
  reminderCancellationReplayed: boolean;
  cleaned: boolean;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Proves AM-004 through AM-007 against an authorised development deployment.
 * Each operation uses a fresh adapter instance to rule out in-process replay.
 * Cleanup removes both live records and retained internal-action results even
 * when a later assertion fails.
 */
export async function runTaskReminderActionsSmoke(
  makeTaskStore: () => ControlledTaskStore,
  makeReminderStore: () => ControlledReminderStore,
  deployment: string | undefined,
  write: SmokeWriter = (message) => console.log(message),
): Promise<TaskReminderActionsSmokeResult> {
  if (!deployment?.trim().startsWith("dev:")) {
    throw new Error(
      "Task/reminder smoke refused: CONVEX_DEPLOYMENT must identify a development deployment (dev:...).",
    );
  }

  const marker = `jarvis-internal-actions-smoke-${randomUUID()}`;
  const projectId = `${marker}-project`;
  let task: ControlledTaskRecord | undefined;
  let reminder: ControlledReminderRecord | undefined;
  let primaryError: Error | undefined;
  let result: TaskReminderActionsSmokeResult | undefined;

  const taskCreate = {
    projectId,
    title: `${marker} task`,
    category: "commissioning",
    idempotencyKey: `${marker}-task-create`,
    actionFingerprint: `jarvis-action-fingerprint:v1:${"b".repeat(64)}`,
    sourceRequestId: `${marker}-task-create-request`,
    correlationId: `${marker}-task-create-correlation`,
    source: "development-commissioning",
  };
  const reminderCreate = {
    projectId,
    title: `${marker} reminder`,
    dueRaw: "tomorrow 7:00 am",
    dueAt: Date.now() + 24 * 60 * 60 * 1_000,
    dueTimezone: "Australia/Melbourne",
    idempotencyKey: `${marker}-reminder-create`,
    actionFingerprint: `jarvis-action-fingerprint:v1:${"c".repeat(64)}`,
    sourceRequestId: `${marker}-reminder-create-request`,
    correlationId: `${marker}-reminder-create-correlation`,
    source: "development-commissioning",
  };

  try {
    task = await makeTaskStore().create(taskCreate);
    requireCondition(task.projectId === projectId, "tasks: created project mismatch.");
    requireCondition(task.revision === 1, "tasks: created revision mismatch.");
    requireCondition(task.completed === false, "tasks: created task was already completed.");

    const taskReplay = await makeTaskStore().create(taskCreate);
    requireCondition(taskReplay.id === task.id, "tasks: create replay produced a second record.");

    const fetchedTask = await makeTaskStore().get(projectId, task.id);
    requireCondition(fetchedTask?.id === task.id, "tasks: fresh store could not fetch created task.");

    const taskComplete = {
      projectId,
      taskId: task.id,
      idempotencyKey: `${marker}-task-complete`,
      actionFingerprint: `jarvis-action-fingerprint:v1:${"d".repeat(64)}`,
      sourceRequestId: `${marker}-task-complete-request`,
      correlationId: `${marker}-task-complete-correlation`,
      source: "development-commissioning",
    };
    const completed = await makeTaskStore().complete(taskComplete);
    requireCondition(completed?.completed === true, "tasks: completion did not persist.");
    requireCondition(completed.revision === 2, "tasks: completion revision mismatch.");
    const completionReplay = await makeTaskStore().complete(taskComplete);
    requireCondition(
      completionReplay?.id === completed.id && completionReplay.completedAt === completed.completedAt,
      "tasks: completion replay did not return the original result.",
    );

    reminder = await makeReminderStore().create(reminderCreate);
    requireCondition(reminder.projectId === projectId, "reminders: created project mismatch.");
    requireCondition(reminder.revision === 1, "reminders: created revision mismatch.");
    const reminderReplay = await makeReminderStore().create(reminderCreate);
    requireCondition(
      reminderReplay.id === reminder.id,
      "reminders: create replay produced a second record.",
    );

    const fetchedReminder = await makeReminderStore().get(projectId, reminder.id);
    requireCondition(
      fetchedReminder?.id === reminder.id,
      "reminders: fresh store could not fetch created reminder.",
    );

    const reminderCancel = {
      projectId,
      reminderId: reminder.id,
      idempotencyKey: `${marker}-reminder-cancel`,
      actionFingerprint: `jarvis-action-fingerprint:v1:${"e".repeat(64)}`,
      sourceRequestId: `${marker}-reminder-cancel-request`,
      correlationId: `${marker}-reminder-cancel-correlation`,
      source: "development-commissioning",
    };
    const cancelled = await makeReminderStore().cancel(reminderCancel);
    requireCondition(cancelled?.cancelledAt !== undefined, "reminders: cancellation result missing.");
    requireCondition(cancelled.revision === 2, "reminders: cancellation revision mismatch.");
    const cancellationReplay = await makeReminderStore().cancel(reminderCancel);
    requireCondition(
      cancellationReplay?.id === cancelled.id &&
        cancellationReplay.cancelledAt === cancelled.cancelledAt,
      "reminders: cancellation replay did not return the retained result.",
    );
    const afterCancellation = await makeReminderStore().get(projectId, reminder.id);
    requireCondition(afterCancellation === null, "reminders: live record remained after cancellation.");

    requireCondition(
      await makeTaskStore().cleanup(projectId, task.id),
      "tasks: cleanup did not remove the controlled task and results.",
    );
    requireCondition(
      await makeReminderStore().cleanup(projectId, reminder.id),
      "reminders: cleanup did not remove retained action results.",
    );
    requireCondition(
      (await makeTaskStore().get(projectId, task.id)) === null,
      "tasks: record remained visible after cleanup.",
    );
    requireCondition(
      (await makeReminderStore().get(projectId, reminder.id)) === null,
      "reminders: record remained visible after cleanup.",
    );
    task = undefined;
    reminder = undefined;

    result = {
      taskCreated: true,
      taskReplayed: true,
      taskRestartVisible: true,
      taskCompleted: true,
      taskCompletionReplayed: true,
      reminderCreated: true,
      reminderReplayed: true,
      reminderRestartVisible: true,
      reminderCancelled: true,
      reminderCancellationReplayed: true,
      cleaned: true,
    };
  } catch (error: unknown) {
    primaryError = normalizeError(error);
  }

  const cleanupErrors: unknown[] = [];
  if (task !== undefined) {
    try {
      await makeTaskStore().cleanup(projectId, task.id);
      requireCondition(
        (await makeTaskStore().get(projectId, task.id)) === null,
        "tasks: record remained after fallback cleanup.",
      );
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  if (reminder !== undefined) {
    try {
      await makeReminderStore().cleanup(projectId, reminder.id);
      requireCondition(
        (await makeReminderStore().get(projectId, reminder.id)) === null,
        "reminders: record remained after fallback cleanup.",
      );
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      "task/reminder smoke cleanup failed.",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  requireCondition(result !== undefined, "task/reminder smoke finished without a result.");

  write(
    "Convex smoke passed for task/reminder actions: create, replay, fresh visibility, complete, cancel and cleanup.",
  );
  return result;
}
