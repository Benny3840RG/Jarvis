import { parseReminderDue, resolveReminderTimezone, type ReminderDue } from "../reminders/due.js";
import { parseSpokenDuePhrase } from "../voice/voiceReminderDue.js";
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
  return resolveTypedDue(text, timezone);
}

const RELATIVE_UNITS: Readonly<Record<string, number>> = {
  minute: 60_000,
  min: 60_000,
  mins: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
};

/**
 * Typed due text ("friday at 9am", "in 2 hours", "tonight at 7") gets the same
 * bounded, fail-closed grammar as a spoken reminder when the strict parser
 * finds no time. Anything still unresolved is kept as text, as before; no
 * time is ever guessed.
 */
function resolveTypedDue(
  text: string,
  timezone: string | undefined,
  now = Date.now(),
): ReminderDue {
  const strict = parseReminderDue(text, { timezone });
  if (strict.at !== undefined) return strict;
  let zone: string;
  try {
    zone = resolveReminderTimezone(timezone);
  } catch {
    return strict;
  }
  const phrase = text
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const relative = /^in (\d{1,4}|an?|one) (minutes?|mins?|hours?|hrs?|days?)$/.exec(phrase);
  if (relative) {
    const count = /^\d/.test(relative[1]!) ? Number(relative[1]) : 1;
    const unit = RELATIVE_UNITS[relative[2]!];
    if (unit !== undefined && count > 0)
      return { raw: text, at: now + count * unit, timezone: zone };
  }
  const spoken = parseSpokenDuePhrase(phrase, { now, timezone: zone });
  if (
    typeof spoken === "object" &&
    spoken.dueAt !== undefined &&
    spoken.dueTimezone !== undefined
  ) {
    return { raw: text, at: spoken.dueAt, timezone: spoken.dueTimezone };
  }
  return strict;
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
