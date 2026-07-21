import { randomUUID } from "node:crypto";

import type { Errand, ErrandInput, ErrandLocation, ErrandUpdate } from "./errand.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }
  return value.trim();
}

function positiveQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Errand quantity must be a positive number.");
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
 * Validates a structured location. The label is mandatory; coordinates are
 * optional but must arrive as a lat/lon pair within real-world ranges, so a
 * stored location is never half-geocoded.
 */
export function normalizeLocation(value: unknown): ErrandLocation {
  if (!isRecord(value)) throw new Error("Errand location must be an object.");
  const label = requiredText(value.label, "Errand location label");
  const hasLat = value.lat !== undefined;
  const hasLon = value.lon !== undefined;
  if (hasLat !== hasLon) {
    throw new Error("Errand location lat and lon must be provided together.");
  }
  return {
    label,
    ...(value.address === undefined
      ? {}
      : { address: requiredText(value.address, "Errand location address") }),
    ...(hasLat ? { lat: coordinate(value.lat, "lat"), lon: coordinate(value.lon, "lon") } : {}),
  };
}

export function cloneErrand(errand: Errand): Errand {
  return { ...errand, ...(errand.location ? { location: { ...errand.location } } : {}) };
}

/** Builds a fully-formed errand from input. */
export function createErrand(input: ErrandInput): Errand {
  const now = Date.now();
  const status = input.status ?? "open";
  return {
    id: randomUUID(),
    title: requiredText(input.title, "Errand title"),
    ...(input.quantity === undefined ? {} : { quantity: positiveQuantity(input.quantity) }),
    status,
    ...(input.location === undefined ? {} : { location: normalizeLocation(input.location) }),
    ...(input.projectId && input.projectId.trim() ? { projectId: input.projectId.trim() } : {}),
    ...(input.notes && input.notes.trim() ? { notes: input.notes.trim() } : {}),
    createdAt: now,
    updatedAt: now,
    ...(status === "done" ? { completedAt: now } : {}),
  };
}

function setOrClearText(errand: Errand, key: "projectId" | "notes", value: string | null): void {
  const cleaned = value === null ? "" : value.trim();
  if (cleaned) errand[key] = cleaned;
  else delete errand[key];
}

/**
 * Applies an update in place. Marking an errand done stamps completedAt once;
 * reopening it clears the stamp.
 */
export function applyErrandUpdate(errand: Errand, update: ErrandUpdate): void {
  if (Object.values(update).every((value) => value === undefined)) {
    throw new Error("Errand update requires at least one changed field.");
  }
  if (update.title !== undefined) errand.title = requiredText(update.title, "Errand title");
  if (update.quantity !== undefined) {
    if (update.quantity === null) delete errand.quantity;
    else errand.quantity = positiveQuantity(update.quantity);
  }
  if (update.location !== undefined) {
    if (update.location === null) delete errand.location;
    else errand.location = normalizeLocation(update.location);
  }
  if (update.projectId !== undefined) setOrClearText(errand, "projectId", update.projectId);
  if (update.notes !== undefined) setOrClearText(errand, "notes", update.notes);
  const now = Date.now();
  if (update.status !== undefined && update.status !== errand.status) {
    errand.status = update.status;
    if (update.status === "done") errand.completedAt = now;
    else delete errand.completedAt;
  }
  errand.updatedAt = now;
}
