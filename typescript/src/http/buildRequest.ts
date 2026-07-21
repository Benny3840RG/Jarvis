import {
  isBuildStatus,
  type BuildInput,
  type BuildStatus,
  type BuildUpdate,
  BUILD_STATUSES,
} from "../builds/build.js";

const MAX_NAME_LENGTH = 200;
const MAX_KIND_LENGTH = 100;
const MAX_NICKNAME_LENGTH = 100;
const MAX_TEXT_LENGTH = 2000;

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

function parseStatus(value: unknown): BuildStatus {
  if (!isBuildStatus(value)) {
    throw new Error(`Build status must be one of: ${BUILD_STATUSES.join(", ")}.`);
  }
  return value;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

const ALLOWED = ["name", "kind", "status", "description", "nickname", "notes"] as const;

export function parseCreateBuild(body: unknown): BuildInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  return {
    name: requiredString(body.name, "Build name", MAX_NAME_LENGTH),
    kind: requiredString(body.kind, "Build kind", MAX_KIND_LENGTH),
    ...(body.status === undefined ? {} : { status: parseStatus(body.status) }),
    ...(body.description === undefined
      ? {}
      : { description: requiredString(body.description, "Build description", MAX_TEXT_LENGTH) }),
    ...(body.nickname === undefined
      ? {}
      : { nickname: requiredString(body.nickname, "Build nickname", MAX_NICKNAME_LENGTH) }),
    ...(body.notes === undefined
      ? {}
      : { notes: requiredString(body.notes, "Build notes", MAX_TEXT_LENGTH) }),
  };
}

export function parseUpdateBuild(body: unknown): BuildUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  if (Object.keys(body).length === 0) {
    throw new Error("Build update requires at least one changed field.");
  }
  const update: BuildUpdate = {};
  if (body.name !== undefined)
    update.name = requiredString(body.name, "Build name", MAX_NAME_LENGTH);
  if (body.kind !== undefined)
    update.kind = requiredString(body.kind, "Build kind", MAX_KIND_LENGTH);
  if (body.status !== undefined) update.status = parseStatus(body.status);
  if (body.description !== undefined) {
    update.description =
      body.description === null
        ? null
        : requiredString(body.description, "Build description", MAX_TEXT_LENGTH);
  }
  if (body.nickname !== undefined) {
    update.nickname =
      body.nickname === null
        ? null
        : requiredString(body.nickname, "Build nickname", MAX_NICKNAME_LENGTH);
  }
  if (body.notes !== undefined) {
    update.notes =
      body.notes === null ? null : requiredString(body.notes, "Build notes", MAX_TEXT_LENGTH);
  }
  return update;
}
