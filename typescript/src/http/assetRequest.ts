import type { AssetInput, AssetUpdate } from "../assets/asset.js";

const MAX_NAME_LENGTH = 200;
const MAX_KIND_LENGTH = 100;
const MAX_NOTES_LENGTH = 2000;

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

function parseInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Asset serviceIntervalDays must be a positive whole number of days.");
  }
  return value;
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Asset lastServicedAt must be a finite timestamp in milliseconds.");
  }
  return value;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

const ALLOWED = ["name", "kind", "serviceIntervalDays", "lastServicedAt", "notes"] as const;

export function parseCreateAsset(body: unknown): AssetInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  return {
    name: requiredString(body.name, "Asset name", MAX_NAME_LENGTH),
    kind: requiredString(body.kind, "Asset kind", MAX_KIND_LENGTH),
    ...(body.serviceIntervalDays === undefined
      ? {}
      : { serviceIntervalDays: parseInterval(body.serviceIntervalDays) }),
    ...(body.lastServicedAt === undefined
      ? {}
      : { lastServicedAt: parseTimestamp(body.lastServicedAt) }),
    ...(body.notes === undefined
      ? {}
      : { notes: requiredString(body.notes, "Asset notes", MAX_NOTES_LENGTH) }),
  };
}

export function parseUpdateAsset(body: unknown): AssetUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  if (Object.keys(body).length === 0) {
    throw new Error("Asset update requires at least one changed field.");
  }
  const update: AssetUpdate = {};
  if (body.name !== undefined)
    update.name = requiredString(body.name, "Asset name", MAX_NAME_LENGTH);
  if (body.kind !== undefined)
    update.kind = requiredString(body.kind, "Asset kind", MAX_KIND_LENGTH);
  if (body.serviceIntervalDays !== undefined) {
    update.serviceIntervalDays =
      body.serviceIntervalDays === null ? null : parseInterval(body.serviceIntervalDays);
  }
  if (body.lastServicedAt !== undefined) {
    update.lastServicedAt =
      body.lastServicedAt === null ? null : parseTimestamp(body.lastServicedAt);
  }
  if (body.notes !== undefined) {
    update.notes =
      body.notes === null ? null : requiredString(body.notes, "Asset notes", MAX_NOTES_LENGTH);
  }
  return update;
}
