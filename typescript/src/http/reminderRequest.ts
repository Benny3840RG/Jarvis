import { parseReminderDue, type ReminderDue } from "../reminders/due.js";
import type { ReminderUpdate } from "../persistence/updates.js";
import { validateReminderUpdate } from "../persistence/updates.js";

const MAX_REMINDER_FIELD_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.trim().length > MAX_REMINDER_FIELD_LENGTH) {
    throw new Error(`${field} must not exceed ${MAX_REMINDER_FIELD_LENGTH} characters.`);
  }
  return value.trim();
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

function parseDue(value: unknown): ReminderDue {
  if (!isRecord(value)) throw new Error("Reminder due must be a JSON object.");
  rejectUnknownKeys(value, ["text", "timezone"]);
  const text = requiredString(value.text, "Reminder due text");
  const timezone =
    value.timezone === undefined ? undefined : requiredString(value.timezone, "Reminder timezone");
  return parseReminderDue(text, { timezone });
}

export function parseCreateReminder(body: unknown): { title: string; due?: ReminderDue } {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["title", "due"]);
  return {
    title: requiredString(body.title, "Reminder title"),
    ...(body.due === undefined ? {} : { due: parseDue(body.due) }),
  };
}

export function parseUpdateReminder(body: unknown): ReminderUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["title", "due"]);
  return validateReminderUpdate({
    ...(body.title === undefined ? {} : { title: requiredString(body.title, "Reminder title") }),
    ...(body.due === undefined ? {} : { due: body.due === null ? null : parseDue(body.due) }),
  });
}
