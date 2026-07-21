import { randomUUID } from "node:crypto";

import type { Asset, AssetInput, AssetUpdate } from "./asset.js";

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }
  return value.trim();
}

export function validServiceInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Asset serviceIntervalDays must be a positive whole number of days.");
  }
  return value;
}

function validTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Asset lastServicedAt must be a finite timestamp in milliseconds.");
  }
  return value;
}

export function cloneAsset(asset: Asset): Asset {
  return { ...asset };
}

/** Builds a fully-formed asset from input. */
export function createAsset(input: AssetInput): Asset {
  const now = Date.now();
  return {
    id: randomUUID(),
    name: requiredText(input.name, "Asset name"),
    kind: requiredText(input.kind, "Asset kind"),
    ...(input.serviceIntervalDays === undefined
      ? {}
      : { serviceIntervalDays: validServiceInterval(input.serviceIntervalDays) }),
    ...(input.lastServicedAt === undefined
      ? {}
      : { lastServicedAt: validTimestamp(input.lastServicedAt) }),
    ...(input.notes && input.notes.trim() ? { notes: input.notes.trim() } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Applies an update in place, bumping updatedAt on any change. */
export function applyAssetUpdate(asset: Asset, update: AssetUpdate): void {
  if (Object.values(update).every((value) => value === undefined)) {
    throw new Error("Asset update requires at least one changed field.");
  }
  if (update.name !== undefined) asset.name = requiredText(update.name, "Asset name");
  if (update.kind !== undefined) asset.kind = requiredText(update.kind, "Asset kind");
  if (update.serviceIntervalDays !== undefined) {
    if (update.serviceIntervalDays === null) delete asset.serviceIntervalDays;
    else asset.serviceIntervalDays = validServiceInterval(update.serviceIntervalDays);
  }
  if (update.lastServicedAt !== undefined) {
    if (update.lastServicedAt === null) delete asset.lastServicedAt;
    else asset.lastServicedAt = validTimestamp(update.lastServicedAt);
  }
  if (update.notes !== undefined) {
    const cleaned = update.notes === null ? "" : update.notes.trim();
    if (cleaned) asset.notes = cleaned;
    else delete asset.notes;
  }
  asset.updatedAt = Date.now();
}
