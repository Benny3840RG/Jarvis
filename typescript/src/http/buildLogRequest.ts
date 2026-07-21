import {
  isBuildLogKind,
  type BuildLogInput,
  type BuildLogKind,
  type BuildLogUpdate,
  BUILD_LOG_KINDS,
} from "../buildLog/buildLogEntry.js";

const MAX_BUILD_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 4000;

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

function parseKind(value: unknown): BuildLogKind {
  if (!isBuildLogKind(value)) {
    throw new Error(`Build log kind must be one of: ${BUILD_LOG_KINDS.join(", ")}.`);
  }
  return value;
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Build log occurredAt must be a finite timestamp in milliseconds.");
  }
  return value;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

const ALLOWED = ["buildId", "kind", "title", "body", "occurredAt"] as const;

export function parseCreateBuildLog(body: unknown): BuildLogInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  return {
    buildId: requiredString(body.buildId, "Build log buildId", MAX_BUILD_ID_LENGTH),
    title: requiredString(body.title, "Build log title", MAX_TITLE_LENGTH),
    ...(body.kind === undefined ? {} : { kind: parseKind(body.kind) }),
    ...(body.body === undefined
      ? {}
      : { body: requiredString(body.body, "Build log body", MAX_BODY_LENGTH) }),
    ...(body.occurredAt === undefined ? {} : { occurredAt: parseTimestamp(body.occurredAt) }),
  };
}

export function parseUpdateBuildLog(body: unknown): BuildLogUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  if (Object.keys(body).length === 0) {
    throw new Error("Build log update requires at least one changed field.");
  }
  const update: BuildLogUpdate = {};
  if (body.buildId !== undefined)
    update.buildId = requiredString(body.buildId, "Build log buildId", MAX_BUILD_ID_LENGTH);
  if (body.kind !== undefined) update.kind = parseKind(body.kind);
  if (body.title !== undefined)
    update.title = requiredString(body.title, "Build log title", MAX_TITLE_LENGTH);
  if (body.body !== undefined) {
    update.body =
      body.body === null ? null : requiredString(body.body, "Build log body", MAX_BODY_LENGTH);
  }
  if (body.occurredAt !== undefined) {
    update.occurredAt = body.occurredAt === null ? null : parseTimestamp(body.occurredAt);
  }
  return update;
}
