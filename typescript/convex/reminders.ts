import type { ConvexClient } from "convex";
import type { ReminderRow } from "./schema";

export const REMINDER_CREATE_FN = "reminders/create";
export const REMINDER_LIST_FN = "reminders/list";
export const REMINDER_UPDATE_FN = "reminders/update";
export const REMINDER_DELETE_FN = "reminders/delete";

export async function createReminder(client: ConvexClient | any, reminder: ReminderRow) {
  return client.mutation(REMINDER_CREATE_FN, reminder);
}

export async function listReminders(client: ConvexClient | any) {
  return client.query(REMINDER_LIST_FN);
}

export async function updateReminder(client: ConvexClient | any, id: string, patch: Partial<ReminderRow>) {
  return client.mutation(REMINDER_UPDATE_FN, { id, patch });
}

export async function deleteReminder(client: ConvexClient | any, id: string) {
  return client.mutation(REMINDER_DELETE_FN, { id });
}
