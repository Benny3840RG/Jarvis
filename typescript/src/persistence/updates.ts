import { validateReminderDue, type ReminderDue } from "../reminders/due.js";

export type TaskUpdate = {
  title?: string;
  category?: string;
};

export type ReminderUpdate = {
  title?: string;
  due?: ReminderDue | null;
};

function cleanText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

export function validateTaskUpdate(update: TaskUpdate): TaskUpdate {
  const title = cleanText(update.title, "Task title");
  const category = cleanText(update.category, "Task category");
  if (title === undefined && category === undefined) {
    throw new Error("Task update requires --title or --category.");
  }
  return {
    ...(title === undefined ? {} : { title }),
    ...(category === undefined ? {} : { category }),
  };
}

export function validateReminderUpdate(update: ReminderUpdate): ReminderUpdate {
  const title = cleanText(update.title, "Reminder title");
  const due = update.due === undefined ? undefined : update.due === null ? null : validateReminderDue(update.due);
  if (title === undefined && due === undefined) {
    throw new Error("Reminder update requires --title, --due, or --clear-due.");
  }
  return {
    ...(title === undefined ? {} : { title }),
    ...(due === undefined ? {} : { due }),
  };
}
