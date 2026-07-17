import type { TaskUpdate } from "../persistence/updates.js";
import { validateTaskUpdate } from "../persistence/updates.js";

const MAX_TASK_FIELD_LENGTH = 100;
const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.trim().length > MAX_TASK_FIELD_LENGTH) {
    throw new Error(`${field} must not exceed ${MAX_TASK_FIELD_LENGTH} characters.`);
  }
  return value.trim();
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

export function parseCreateTask(body: unknown): { title: string; category: string } {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["title", "category"]);
  return {
    title: requiredString(body.title, "Task title"),
    category:
      body.category === undefined ? "personal" : requiredString(body.category, "Task category"),
  };
}

export function parseUpdateTask(body: unknown): TaskUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["title", "category"]);
  return validateTaskUpdate({
    ...(body.title === undefined ? {} : { title: requiredString(body.title, "Task title") }),
    ...(body.category === undefined
      ? {}
      : { category: requiredString(body.category, "Task category") }),
  });
}

export function parseIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error(
      `Idempotency-Key must be ${MIN_IDEMPOTENCY_KEY_LENGTH} to ${MAX_IDEMPOTENCY_KEY_LENGTH} safe characters.`,
    );
  }
  return value;
}
