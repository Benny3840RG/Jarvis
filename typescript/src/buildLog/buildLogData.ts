import { randomUUID } from "node:crypto";

import {
  BUILD_LOG_KINDS,
  isBuildLogKind,
  type BuildLogEntry,
  type BuildLogInput,
  type BuildLogKind,
  type BuildLogUpdate,
} from "./buildLogEntry.js";

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }
  return value.trim();
}

function validKind(value: unknown): BuildLogKind {
  if (!isBuildLogKind(value)) {
    throw new Error(`Build log kind must be one of: ${BUILD_LOG_KINDS.join(", ")}.`);
  }
  return value;
}

function validTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Build log occurredAt must be a finite timestamp in milliseconds.");
  }
  return value;
}

export function cloneBuildLogEntry(entry: BuildLogEntry): BuildLogEntry {
  return { ...entry };
}

/** Builds a fully-formed build-log entry from input. */
export function createBuildLogEntry(input: BuildLogInput): BuildLogEntry {
  return {
    id: randomUUID(),
    buildId: requiredText(input.buildId, "Build log buildId"),
    kind: input.kind === undefined ? "note" : validKind(input.kind),
    title: requiredText(input.title, "Build log title"),
    ...(input.body && input.body.trim() ? { body: input.body.trim() } : {}),
    ...(input.occurredAt === undefined ? {} : { occurredAt: validTimestamp(input.occurredAt) }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Applies an update in place. */
export function applyBuildLogUpdate(entry: BuildLogEntry, update: BuildLogUpdate): void {
  if (Object.values(update).every((value) => value === undefined)) {
    throw new Error("Build log update requires at least one changed field.");
  }
  if (update.buildId !== undefined)
    entry.buildId = requiredText(update.buildId, "Build log buildId");
  if (update.kind !== undefined) entry.kind = validKind(update.kind);
  if (update.title !== undefined) entry.title = requiredText(update.title, "Build log title");
  if (update.body !== undefined) {
    const cleaned = update.body === null ? "" : update.body.trim();
    if (cleaned) entry.body = cleaned;
    else delete entry.body;
  }
  if (update.occurredAt !== undefined) {
    if (update.occurredAt === null) delete entry.occurredAt;
    else entry.occurredAt = validTimestamp(update.occurredAt);
  }
  entry.updatedAt = Date.now();
}
