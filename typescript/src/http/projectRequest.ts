import {
  isProjectStatus,
  type ProjectInput,
  type ProjectStatus,
  type ProjectUpdate,
  PROJECT_STATUSES,
} from "../projects/project.js";

const MAX_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
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

function parseStatus(value: unknown): ProjectStatus {
  if (!isProjectStatus(value)) {
    throw new Error(`Project status must be one of: ${PROJECT_STATUSES.join(", ")}.`);
  }
  return value;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

const ALLOWED = ["clientId", "title", "status", "notes"] as const;

export function parseCreateProject(body: unknown): ProjectInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  return {
    clientId: requiredString(body.clientId, "Project clientId", MAX_ID_LENGTH),
    title: requiredString(body.title, "Project title", MAX_TITLE_LENGTH),
    ...(body.status === undefined ? {} : { status: parseStatus(body.status) }),
    ...(body.notes === undefined
      ? {}
      : { notes: requiredString(body.notes, "Project notes", MAX_NOTES_LENGTH) }),
  };
}

export function parseUpdateProject(body: unknown): ProjectUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  if (
    body.clientId === undefined &&
    body.title === undefined &&
    body.status === undefined &&
    body.notes === undefined
  ) {
    throw new Error("Project update requires a clientId, title, status, or notes change.");
  }
  const update: ProjectUpdate = {};
  if (body.clientId !== undefined)
    update.clientId = requiredString(body.clientId, "Project clientId", MAX_ID_LENGTH);
  if (body.title !== undefined)
    update.title = requiredString(body.title, "Project title", MAX_TITLE_LENGTH);
  if (body.status !== undefined) update.status = parseStatus(body.status);
  if (body.notes !== undefined) {
    update.notes =
      body.notes === null ? null : requiredString(body.notes, "Project notes", MAX_NOTES_LENGTH);
  }
  return update;
}
