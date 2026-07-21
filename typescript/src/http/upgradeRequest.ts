import type { UpgradeInput, UpgradeUpdate } from "../upgrades/upgrade.js";

const MAX_BUILD_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 4000;
const MAX_VERSION_LENGTH = 100;
const MAX_PART_LENGTH = 200;
const MAX_PARTS = 100;

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

function parseTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Upgrade occurredAt must be a finite timestamp in milliseconds.");
  }
  return value;
}

function parseParts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Upgrade parts must be an array of strings.");
  if (value.length > MAX_PARTS)
    throw new Error(`Upgrade parts must not exceed ${MAX_PARTS} items.`);
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("Upgrade parts must be an array of strings.");
    const trimmed = item.trim();
    if (trimmed.length > MAX_PART_LENGTH)
      throw new Error(`Each upgrade part must not exceed ${MAX_PART_LENGTH} characters.`);
    if (trimmed) parts.push(trimmed);
  }
  return parts;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

const ALLOWED = [
  "buildId",
  "title",
  "reason",
  "beforeState",
  "afterState",
  "outcome",
  "parts",
  "version",
  "occurredAt",
] as const;

export function parseCreateUpgrade(body: unknown): UpgradeInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  return {
    buildId: requiredString(body.buildId, "Upgrade buildId", MAX_BUILD_ID_LENGTH),
    title: requiredString(body.title, "Upgrade title", MAX_TITLE_LENGTH),
    ...(body.reason === undefined
      ? {}
      : { reason: requiredString(body.reason, "Upgrade reason", MAX_TEXT_LENGTH) }),
    ...(body.beforeState === undefined
      ? {}
      : { beforeState: requiredString(body.beforeState, "Upgrade beforeState", MAX_TEXT_LENGTH) }),
    ...(body.afterState === undefined
      ? {}
      : { afterState: requiredString(body.afterState, "Upgrade afterState", MAX_TEXT_LENGTH) }),
    ...(body.outcome === undefined
      ? {}
      : { outcome: requiredString(body.outcome, "Upgrade outcome", MAX_TEXT_LENGTH) }),
    ...(body.parts === undefined ? {} : { parts: parseParts(body.parts) }),
    ...(body.version === undefined
      ? {}
      : { version: requiredString(body.version, "Upgrade version", MAX_VERSION_LENGTH) }),
    ...(body.occurredAt === undefined ? {} : { occurredAt: parseTimestamp(body.occurredAt) }),
  };
}

export function parseUpdateUpgrade(body: unknown): UpgradeUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  if (Object.keys(body).length === 0) {
    throw new Error("Upgrade update requires at least one changed field.");
  }
  const update: UpgradeUpdate = {};
  if (body.buildId !== undefined)
    update.buildId = requiredString(body.buildId, "Upgrade buildId", MAX_BUILD_ID_LENGTH);
  if (body.title !== undefined)
    update.title = requiredString(body.title, "Upgrade title", MAX_TITLE_LENGTH);
  if (body.reason !== undefined) {
    update.reason =
      body.reason === null ? null : requiredString(body.reason, "Upgrade reason", MAX_TEXT_LENGTH);
  }
  if (body.beforeState !== undefined) {
    update.beforeState =
      body.beforeState === null
        ? null
        : requiredString(body.beforeState, "Upgrade beforeState", MAX_TEXT_LENGTH);
  }
  if (body.afterState !== undefined) {
    update.afterState =
      body.afterState === null
        ? null
        : requiredString(body.afterState, "Upgrade afterState", MAX_TEXT_LENGTH);
  }
  if (body.outcome !== undefined) {
    update.outcome =
      body.outcome === null
        ? null
        : requiredString(body.outcome, "Upgrade outcome", MAX_TEXT_LENGTH);
  }
  if (body.parts !== undefined) {
    update.parts = body.parts === null ? null : parseParts(body.parts);
  }
  if (body.version !== undefined) {
    update.version =
      body.version === null
        ? null
        : requiredString(body.version, "Upgrade version", MAX_VERSION_LENGTH);
  }
  if (body.occurredAt !== undefined) {
    update.occurredAt = body.occurredAt === null ? null : parseTimestamp(body.occurredAt);
  }
  return update;
}
