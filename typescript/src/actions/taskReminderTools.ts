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

export function createTaskReminderToolDefinitions(
  taskStore: ControlledTaskStore,
  reminderStore: ControlledReminderStore,
): ToolExecutionDefinition[] {
  return [
    createTaskToolDefinition(taskStore),
    completeTaskToolDefinition(taskStore),
    createReminderToolDefinition(reminderStore),
    cancelReminderToolDefinition(reminderStore),
  ];
}
