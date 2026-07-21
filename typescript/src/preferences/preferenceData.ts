import { randomUUID } from "node:crypto";

import type { Preference, PreferenceInput, PreferenceUpdate } from "./preference.js";

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }
  return value.trim();
}

export function clonePreference(preference: Preference): Preference {
  return { ...preference };
}

/** Builds a fully-formed preference from input. */
export function createPreference(input: PreferenceInput): Preference {
  const now = Date.now();
  return {
    id: randomUUID(),
    key: requiredText(input.key, "Preference key"),
    value: requiredText(input.value, "Preference value"),
    ...(input.category && input.category.trim() ? { category: input.category.trim() } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Applies an update in place, bumping updatedAt on any change. */
export function applyPreferenceUpdate(preference: Preference, update: PreferenceUpdate): void {
  if (Object.values(update).every((value) => value === undefined)) {
    throw new Error("Preference update requires at least one changed field.");
  }
  if (update.key !== undefined) preference.key = requiredText(update.key, "Preference key");
  if (update.value !== undefined) preference.value = requiredText(update.value, "Preference value");
  if (update.category !== undefined) {
    const cleaned = update.category === null ? "" : update.category.trim();
    if (cleaned) preference.category = cleaned;
    else delete preference.category;
  }
  preference.updatedAt = Date.now();
}
