import { randomUUID } from "node:crypto";

import type { Upgrade, UpgradeInput, UpgradeUpdate } from "./upgrade.js";

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }
  return value.trim();
}

function validTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Upgrade occurredAt must be a finite timestamp in milliseconds.");
  }
  return value;
}

/** Trims each part and drops empties. Returns undefined when nothing survives. */
export function normalizeParts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    throw new Error("Upgrade parts must be an array of strings.");
  }
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("Upgrade parts must be an array of strings.");
    const trimmed = item.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.length > 0 ? parts : undefined;
}

export function cloneUpgrade(entry: Upgrade): Upgrade {
  return { ...entry, ...(entry.parts ? { parts: [...entry.parts] } : {}) };
}

/** Builds a fully-formed upgrade entry from input. */
export function createUpgrade(input: UpgradeInput): Upgrade {
  const parts = input.parts === undefined ? undefined : normalizeParts(input.parts);
  return {
    id: randomUUID(),
    buildId: requiredText(input.buildId, "Upgrade buildId"),
    title: requiredText(input.title, "Upgrade title"),
    ...(input.reason && input.reason.trim() ? { reason: input.reason.trim() } : {}),
    ...(input.beforeState && input.beforeState.trim()
      ? { beforeState: input.beforeState.trim() }
      : {}),
    ...(input.afterState && input.afterState.trim() ? { afterState: input.afterState.trim() } : {}),
    ...(input.outcome && input.outcome.trim() ? { outcome: input.outcome.trim() } : {}),
    ...(parts ? { parts } : {}),
    ...(input.version && input.version.trim() ? { version: input.version.trim() } : {}),
    ...(input.occurredAt === undefined ? {} : { occurredAt: validTimestamp(input.occurredAt) }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function applyNullableText(
  update: UpgradeUpdate,
  key: "reason" | "beforeState" | "afterState" | "outcome" | "version",
  entry: Upgrade,
): void {
  const value = update[key];
  if (value === undefined) return;
  const cleaned = value === null ? "" : value.trim();
  if (cleaned) entry[key] = cleaned;
  else delete entry[key];
}

/** Applies an update in place. */
export function applyUpgradeUpdate(entry: Upgrade, update: UpgradeUpdate): void {
  if (Object.values(update).every((value) => value === undefined)) {
    throw new Error("Upgrade update requires at least one changed field.");
  }
  if (update.buildId !== undefined) entry.buildId = requiredText(update.buildId, "Upgrade buildId");
  if (update.title !== undefined) entry.title = requiredText(update.title, "Upgrade title");
  applyNullableText(update, "reason", entry);
  applyNullableText(update, "beforeState", entry);
  applyNullableText(update, "afterState", entry);
  applyNullableText(update, "outcome", entry);
  applyNullableText(update, "version", entry);
  if (update.parts !== undefined) {
    const parts = update.parts === null ? undefined : normalizeParts(update.parts);
    if (parts) entry.parts = parts;
    else delete entry.parts;
  }
  if (update.occurredAt !== undefined) {
    if (update.occurredAt === null) delete entry.occurredAt;
    else entry.occurredAt = validTimestamp(update.occurredAt);
  }
  entry.updatedAt = Date.now();
}
