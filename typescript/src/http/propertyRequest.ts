import type { PropertyInput, PropertyUpdate } from "../properties/property.js";

const MAX_ID_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 500;
const MAX_NOTE_LENGTH = 2000;
const MAX_HAZARD_LENGTH = 200;
const MAX_HAZARDS = 50;

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

function parseHazards(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Property hazards must be an array.");
  if (value.length > MAX_HAZARDS) throw new Error(`No more than ${MAX_HAZARDS} hazards.`);
  return [
    ...new Set(value.map((entry) => requiredString(entry, "Property hazard", MAX_HAZARD_LENGTH))),
  ];
}

const ALLOWED = ["clientId", "address", "hazards", "accessNotes", "serviceNotes"] as const;

export function parseCreateProperty(body: unknown): PropertyInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  return {
    clientId: requiredString(body.clientId, "Property clientId", MAX_ID_LENGTH),
    address: requiredString(body.address, "Property address", MAX_ADDRESS_LENGTH),
    ...(body.hazards === undefined ? {} : { hazards: parseHazards(body.hazards) }),
    ...(body.accessNotes === undefined
      ? {}
      : { accessNotes: requiredString(body.accessNotes, "Property accessNotes", MAX_NOTE_LENGTH) }),
    ...(body.serviceNotes === undefined
      ? {}
      : {
          serviceNotes: requiredString(body.serviceNotes, "Property serviceNotes", MAX_NOTE_LENGTH),
        }),
  };
}

export function parseUpdateProperty(body: unknown): PropertyUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  if (Object.keys(body).length === 0) {
    throw new Error("Property update requires at least one changed field.");
  }
  const update: PropertyUpdate = {};
  if (body.clientId !== undefined)
    update.clientId = requiredString(body.clientId, "Property clientId", MAX_ID_LENGTH);
  if (body.address !== undefined)
    update.address = requiredString(body.address, "Property address", MAX_ADDRESS_LENGTH);
  if (body.hazards !== undefined) update.hazards = parseHazards(body.hazards);
  if (body.accessNotes !== undefined) {
    update.accessNotes =
      body.accessNotes === null
        ? null
        : requiredString(body.accessNotes, "Property accessNotes", MAX_NOTE_LENGTH);
  }
  if (body.serviceNotes !== undefined) {
    update.serviceNotes =
      body.serviceNotes === null
        ? null
        : requiredString(body.serviceNotes, "Property serviceNotes", MAX_NOTE_LENGTH);
  }
  return update;
}
