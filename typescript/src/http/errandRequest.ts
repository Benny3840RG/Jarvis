import {
  isErrandStatus,
  type ErrandInput,
  type ErrandLocation,
  type ErrandStatus,
  type ErrandUpdate,
  ERRAND_STATUSES,
} from "../errands/errand.js";

const MAX_TITLE_LENGTH = 500;
const MAX_LABEL_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 500;
const MAX_ID_LENGTH = 200;
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

function positiveQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Errand quantity must be a positive number.");
  }
  return value;
}

function parseStatus(value: unknown): ErrandStatus {
  if (!isErrandStatus(value)) {
    throw new Error(`Errand status must be one of: ${ERRAND_STATUSES.join(", ")}.`);
  }
  return value;
}

function coordinate(value: unknown, field: "lat" | "lon"): number {
  const bound = field === "lat" ? 90 : 180;
  if (typeof value !== "number" || !Number.isFinite(value) || value < -bound || value > bound) {
    throw new Error(`Errand location ${field} must be a number between -${bound} and ${bound}.`);
  }
  return value;
}

/**
 * Parses a structured location. Coordinates are optional but only as a pair —
 * the assistant geocodes at the conversation layer and passes both, or neither.
 */
function parseLocation(value: unknown): ErrandLocation {
  if (!isRecord(value)) throw new Error("Errand location must be a JSON object.");
  const allowed = ["label", "address", "lat", "lon"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Errand location contains unsupported fields.");
  }
  const hasLat = value.lat !== undefined;
  const hasLon = value.lon !== undefined;
  if (hasLat !== hasLon) {
    throw new Error("Errand location lat and lon must be provided together.");
  }
  return {
    label: requiredString(value.label, "Errand location label", MAX_LABEL_LENGTH),
    ...(value.address === undefined
      ? {}
      : { address: requiredString(value.address, "Errand location address", MAX_ADDRESS_LENGTH) }),
    ...(hasLat ? { lat: coordinate(value.lat, "lat"), lon: coordinate(value.lon, "lon") } : {}),
  };
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

const ALLOWED = ["title", "quantity", "status", "location", "projectId", "notes"] as const;

export function parseCreateErrand(body: unknown): ErrandInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  return {
    title: requiredString(body.title, "Errand title", MAX_TITLE_LENGTH),
    ...(body.quantity === undefined ? {} : { quantity: positiveQuantity(body.quantity) }),
    ...(body.status === undefined ? {} : { status: parseStatus(body.status) }),
    ...(body.location === undefined ? {} : { location: parseLocation(body.location) }),
    ...(body.projectId === undefined
      ? {}
      : { projectId: requiredString(body.projectId, "Errand projectId", MAX_ID_LENGTH) }),
    ...(body.notes === undefined
      ? {}
      : { notes: requiredString(body.notes, "Errand notes", MAX_NOTES_LENGTH) }),
  };
}

export function parseUpdateErrand(body: unknown): ErrandUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  if (Object.keys(body).length === 0) {
    throw new Error("Errand update requires at least one changed field.");
  }
  const update: ErrandUpdate = {};
  if (body.title !== undefined)
    update.title = requiredString(body.title, "Errand title", MAX_TITLE_LENGTH);
  if (body.quantity !== undefined) {
    update.quantity = body.quantity === null ? null : positiveQuantity(body.quantity);
  }
  if (body.status !== undefined) update.status = parseStatus(body.status);
  if (body.location !== undefined) {
    update.location = body.location === null ? null : parseLocation(body.location);
  }
  if (body.projectId !== undefined) {
    update.projectId =
      body.projectId === null
        ? null
        : requiredString(body.projectId, "Errand projectId", MAX_ID_LENGTH);
  }
  if (body.notes !== undefined) {
    update.notes =
      body.notes === null ? null : requiredString(body.notes, "Errand notes", MAX_NOTES_LENGTH);
  }
  return update;
}
