import type { PreferenceInput, PreferenceUpdate } from "../preferences/preference.js";

const MAX_KEY_LENGTH = 200;
const MAX_VALUE_LENGTH = 2000;
const MAX_CATEGORY_LENGTH = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.trim().length > max) throw new Error(`${field} must not exceed ${max} characters.`);
  return value.trim();
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

const ALLOWED = ["key", "value", "category"] as const;

export function parseCreatePreference(body: unknown): PreferenceInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  return {
    key: requiredString(body.key, "Preference key", MAX_KEY_LENGTH),
    value: requiredString(body.value, "Preference value", MAX_VALUE_LENGTH),
    ...(body.category === undefined
      ? {}
      : { category: requiredString(body.category, "Preference category", MAX_CATEGORY_LENGTH) }),
  };
}

export function parseUpdatePreference(body: unknown): PreferenceUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  if (Object.keys(body).length === 0) {
    throw new Error("Preference update requires at least one changed field.");
  }
  const update: PreferenceUpdate = {};
  if (body.key !== undefined)
    update.key = requiredString(body.key, "Preference key", MAX_KEY_LENGTH);
  if (body.value !== undefined)
    update.value = requiredString(body.value, "Preference value", MAX_VALUE_LENGTH);
  if (body.category !== undefined) {
    update.category =
      body.category === null
        ? null
        : requiredString(body.category, "Preference category", MAX_CATEGORY_LENGTH);
  }
  return update;
}
