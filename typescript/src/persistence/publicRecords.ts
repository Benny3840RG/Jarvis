import type { Reminder, Task } from "./types.js";

/** Fields the task HTTP responses already return. Direct-create identity stays internal. */
export type PublicTask = Pick<Task, "id" | "title" | "completed" | "category" | "createdAt">;

/** Fields the reminder HTTP responses already return. Direct-create identity stays internal. */
export type PublicReminder = Pick<
  Reminder,
  "id" | "title" | "dueRaw" | "dueAt" | "dueTimezone" | "createdAt"
>;

export function publicTask(task: Task): PublicTask {
  return {
    id: task.id,
    title: task.title,
    completed: task.completed,
    category: task.category,
    createdAt: task.createdAt,
  };
}

export function publicReminder(reminder: Reminder): PublicReminder {
  return {
    id: reminder.id,
    title: reminder.title,
    ...(reminder.dueRaw === undefined ? {} : { dueRaw: reminder.dueRaw }),
    ...(reminder.dueAt === undefined
      ? {}
      : { dueAt: reminder.dueAt, dueTimezone: reminder.dueTimezone }),
    createdAt: reminder.createdAt,
  };
}
