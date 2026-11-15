import { z } from "zod";

import type { ControlledReminderStore } from "../reminders/controlledReminder.js";
import type { ControlledTaskStore } from "../tasks/controlledTask.js";
import type { ToolExecutionDefinition } from "./toolExecution.js";

export const TASK_TOOL = "tasks";
export const CREATE_TASK_OPERATION = "create";
export const COMPLETE_TASK_OPERATION = "complete";
export const REMINDER_TOOL = "reminders";
export const CREATE_REMINDER_OPERATION = "create";
export const CANCEL_REMINDER_OPERATION = "cancel";
export const RESCHEDULE_REMINDER_OPERATION = "reschedule";

/**
 * AM-017 (Reschedule reminder) is lifecycle_status planned. Its executor is
 * registered only when this is exactly "true", after the owner has deployed
 * the Convex mutation and run the commissioning smoke.
 */
export const REMINDER_RESCHEDULE_ENABLED_ENV = "JARVIS_REMINDER_RESCHEDULE_ENABLED";

export function reminderRescheduleEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REMINDER_RESCHEDULE_ENABLED_ENV] === "true";
}

export const createTaskArgumentsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(100),
  })
  .strict();

export const completeTaskArgumentsSchema = z
  .object({
    taskId: z.string().trim().min(1).max(200),
  })
  .strict();

export const createReminderArgumentsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    dueRaw: z.string().trim().min(1).max(500).optional(),
    dueAt: z.number().finite().optional(),
    dueTimezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasTimestamp = value.dueAt !== undefined;
    const hasTimezone = value.dueTimezone !== undefined;
    if (hasTimestamp !== hasTimezone) {
      context.addIssue({
        code: "custom",
        message: "A normalized reminder due value requires both dueAt and dueTimezone.",
      });
    }
    if (hasTimestamp && value.dueRaw === undefined) {
      context.addIssue({
        code: "custom",
        message: "A normalized reminder due value requires preserved dueRaw text.",
      });
    }
  });

/** A new due value only: raw text always, a normalized instant only with its timezone. */
export const rescheduleReminderArgumentsSchema = z
  .object({
    reminderId: z.string().trim().min(1).max(200),
    dueRaw: z.string().trim().min(1).max(500),
    dueAt: z.number().finite().optional(),
    dueTimezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.dueAt === undefined) !== (value.dueTimezone === undefined)) {
      context.addIssue({
        code: "custom",
        message: "A normalized reminder due value requires both dueAt and dueTimezone.",
      });
    }
  });

export const cancelReminderArgumentsSchema = z
  .object({
    reminderId: z.string().trim().min(1).max(200),
  })
  .strict();

export function createTaskToolDefinition(store: ControlledTaskStore): ToolExecutionDefinition {
  return {
    tool: TASK_TOOL,
    operation: CREATE_TASK_OPERATION,
    schema: createTaskArgumentsSchema,
    async execute(argumentsValue, _signal, context) {
      const parsed = createTaskArgumentsSchema.parse(argumentsValue);
      return store.create({
        projectId: context.action.projectId,
        title: parsed.title,
        category: parsed.category,
        idempotencyKey: context.idempotencyKey,
        actionFingerprint: context.actionFingerprint,
        sourceRequestId: context.action.requestId,
        correlationId: context.correlationId,
        source: context.source,
      });
    },
  };
}

export function completeTaskToolDefinition(store: ControlledTaskStore): ToolExecutionDefinition {
  return {
    tool: TASK_TOOL,
    operation: COMPLETE_TASK_OPERATION,
    schema: completeTaskArgumentsSchema,
    async execute(argumentsValue, _signal, context) {
      const parsed = completeTaskArgumentsSchema.parse(argumentsValue);
      const completed = await store.complete({
        projectId: context.action.projectId,
        taskId: parsed.taskId,
        idempotencyKey: context.idempotencyKey,
        actionFingerprint: context.actionFingerprint,
        sourceRequestId: context.action.requestId,
        correlationId: context.correlationId,
        source: context.source,
      });
      if (completed === null) throw new Error("Controlled task was not found in this project.");
      return completed;
    },
  };
}

export function createReminderToolDefinition(
  store: ControlledReminderStore,
): ToolExecutionDefinition {
  return {
    tool: REMINDER_TOOL,
    operation: CREATE_REMINDER_OPERATION,
    schema: createReminderArgumentsSchema,
    async execute(argumentsValue, _signal, context) {
      const parsed = createReminderArgumentsSchema.parse(argumentsValue);
      return store.create({
        projectId: context.action.projectId,
        title: parsed.title,
        ...(parsed.dueRaw === undefined ? {} : { dueRaw: parsed.dueRaw }),
        ...(parsed.dueAt === undefined ? {} : { dueAt: parsed.dueAt }),
        ...(parsed.dueTimezone === undefined ? {} : { dueTimezone: parsed.dueTimezone }),
        idempotencyKey: context.idempotencyKey,
        actionFingerprint: context.actionFingerprint,
        sourceRequestId: context.action.requestId,
        correlationId: context.correlationId,
        source: context.source,
      });
    },
  };
}

export function cancelReminderToolDefinition(
  store: ControlledReminderStore,
): ToolExecutionDefinition {
  return {
    tool: REMINDER_TOOL,
    operation: CANCEL_REMINDER_OPERATION,
    schema: cancelReminderArgumentsSchema,
    async execute(argumentsValue, _signal, context) {
      const parsed = cancelReminderArgumentsSchema.parse(argumentsValue);
      const cancelled = await store.cancel({
        projectId: context.action.projectId,
        reminderId: parsed.reminderId,
        idempotencyKey: context.idempotencyKey,
        actionFingerprint: context.actionFingerprint,
        sourceRequestId: context.action.requestId,
        correlationId: context.correlationId,
        source: context.source,
      });
      if (cancelled === null) {
        throw new Error("Controlled reminder was not found in this project.");
      }
      return cancelled;
    },
  };
}

export function rescheduleReminderToolDefinition(
  store: ControlledReminderStore,
): ToolExecutionDefinition {
  return {
    tool: REMINDER_TOOL,
    operation: RESCHEDULE_REMINDER_OPERATION,
    schema: rescheduleReminderArgumentsSchema,
    async execute(argumentsValue, _signal, context) {
      const parsed = rescheduleReminderArgumentsSchema.parse(argumentsValue);
      if (!store.reschedule) throw new Error("This reminder store cannot reschedule reminders.");
      const rescheduled = await store.reschedule({
        projectId: context.action.projectId,
        reminderId: parsed.reminderId,
        dueRaw: parsed.dueRaw,
        ...(parsed.dueAt === undefined ? {} : { dueAt: parsed.dueAt }),
        ...(parsed.dueTimezone === undefined ? {} : { dueTimezone: parsed.dueTimezone }),
        idempotencyKey: context.idempotencyKey,
        actionFingerprint: context.actionFingerprint,
        sourceRequestId: context.action.requestId,
        correlationId: context.correlationId,
        source: context.source,
      });
      if (rescheduled === null) {
        throw new Error("Controlled reminder was not found in this project.");
      }
      return rescheduled;
    },
  };
}

export function createTaskReminderToolDefinitions(
  taskStore: ControlledTaskStore,
  reminderStore: ControlledReminderStore,
  options: { reminderReschedule?: boolean } = {},
): ToolExecutionDefinition[] {
  return [
    createTaskToolDefinition(taskStore),
    completeTaskToolDefinition(taskStore),
    createReminderToolDefinition(reminderStore),
    cancelReminderToolDefinition(reminderStore),
    // AM-017 is planned: only with the explicit flag and a store that supports it.
    ...(options.reminderReschedule === true && reminderStore.reschedule !== undefined
      ? [rescheduleReminderToolDefinition(reminderStore)]
      : []),
  ];
}
