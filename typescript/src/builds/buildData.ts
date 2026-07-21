import { randomUUID } from "node:crypto";

import type { Build, BuildInput, BuildUpdate } from "./build.js";

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }
  return value.trim();
}

export function cloneBuild(build: Build): Build {
  return { ...build };
}

/** Builds a fully-formed build record from input. */
export function createBuild(input: BuildInput): Build {
  const now = Date.now();
  return {
    id: randomUUID(),
    name: requiredText(input.name, "Build name"),
    kind: requiredText(input.kind, "Build kind"),
    status: input.status ?? "planning",
    ...(input.description && input.description.trim()
      ? { description: input.description.trim() }
      : {}),
    ...(input.nickname && input.nickname.trim() ? { nickname: input.nickname.trim() } : {}),
    ...(input.notes && input.notes.trim() ? { notes: input.notes.trim() } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function setOrClear(
  build: Build,
  key: "description" | "nickname" | "notes",
  value: string | null,
): void {
  const cleaned = value === null ? "" : value.trim();
  if (cleaned) build[key] = cleaned;
  else delete build[key];
}

/** Applies an update in place. */
export function applyBuildUpdate(build: Build, update: BuildUpdate): void {
  if (Object.values(update).every((value) => value === undefined)) {
    throw new Error("Build update requires at least one changed field.");
  }
  if (update.name !== undefined) build.name = requiredText(update.name, "Build name");
  if (update.kind !== undefined) build.kind = requiredText(update.kind, "Build kind");
  if (update.status !== undefined) build.status = update.status;
  if (update.description !== undefined) setOrClear(build, "description", update.description);
  if (update.nickname !== undefined) setOrClear(build, "nickname", update.nickname);
  if (update.notes !== undefined) setOrClear(build, "notes", update.notes);
  build.updatedAt = Date.now();
}
