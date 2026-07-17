import type { TaskUpdate } from "../persistence/updates.js";
import { validateTaskUpdate } from "../persistence/updates.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.trim().length > 100) throw new Error(`${field} must not exceed 100 characters.`);
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
    category: body.category === undefined ? "personal" : requiredString(body.category, "Task category"),
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
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new Error("Idempotency-Key must be 8 to 128 safe characters.");
  }
  return value;
}
