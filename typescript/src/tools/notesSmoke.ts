import { randomUUID } from "node:crypto";

import type { CreateNoteInput, NoteRecord, NoteStore } from "../notes/note.js";
import type { SmokeWriter } from "./convexSmoke.js";

export type NotesSmokeResult = {
  created: boolean;
  replayed: boolean;
  restartVisible: boolean;
  removed: boolean;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Proves AM-003's durable Notes boundary against a development deployment.
 * Every store operation uses a fresh store instance, so replay and visibility
 * cannot be satisfied by an in-process cache. The created note is removed even
 * when a later assertion fails.
 */
export async function runNotesSmoke(
  makeStore: () => NoteStore,
  deployment: string | undefined,
  write: SmokeWriter = (message) => console.log(message),
): Promise<NotesSmokeResult> {
  if (!deployment?.trim().startsWith("dev:")) {
    throw new Error(
      "Notes smoke refused: CONVEX_DEPLOYMENT must identify a development deployment (dev:...).",
    );
  }

  const marker = `jarvis-note-smoke-${randomUUID()}`;
  const projectId = `${marker}-project`;
  const input: CreateNoteInput = {
    projectId,
    title: `${marker} title`,
    body: `${marker} body`,
    tags: ["commissioning", "self-cleaning"],
    domain: "workshop",
    sensitivity: "private",
    retention: "ephemeral",
    idempotencyKey: `${marker}-idempotency`,
    actionFingerprint: `jarvis-action-fingerprint:v1:${"a".repeat(64)}`,
    sourceRequestId: `${marker}-request`,
    correlationId: `${marker}-correlation`,
    source: "development-commissioning",
  };

  let created: NoteRecord | undefined;
  let primaryError: Error | undefined;
  let result: NotesSmokeResult | undefined;

  try {
    created = await makeStore().create(input);
    requireCondition(created.projectId === projectId, "notes: created project mismatch.");
    requireCondition(created.title === input.title, "notes: created title mismatch.");
    requireCondition(created.body === input.body, "notes: created body mismatch.");
    requireCondition(created.revision === 1, "notes: created revision mismatch.");

    const replay = await makeStore().create(input);
    requireCondition(replay.id === created.id, "notes: idempotent replay created a second record.");

    const fetched = await makeStore().get(projectId, created.id);
    requireCondition(
      fetched?.id === created.id,
      "notes: fresh store could not fetch created note.",
    );

    const listed = await makeStore().list(projectId, 25);
    requireCondition(
      listed.some((note) => note.id === created?.id),
      "notes: fresh store list did not contain created note.",
    );

    const removed = await makeStore().remove(projectId, created.id);
    requireCondition(
      removed?.id === created.id,
      "notes: cleanup remove did not return created note.",
    );

    const afterRemoval = await makeStore().get(projectId, created.id);
    requireCondition(afterRemoval === null, "notes: record remained visible after cleanup.");
    created = undefined;

    result = { created: true, replayed: true, restartVisible: true, removed: true };
  } catch (error: unknown) {
    primaryError = normalizeError(error);
  }

  const cleanupErrors: unknown[] = [];
  if (created !== undefined) {
    try {
      await makeStore().remove(projectId, created.id);
      const afterCleanup = await makeStore().get(projectId, created.id);
      requireCondition(afterCleanup === null, "notes: record remained after fallback cleanup.");
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      "notes: smoke cleanup failed.",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  requireCondition(result !== undefined, "notes: smoke finished without a result.");

  write("Convex smoke passed for notes: create, idempotent replay, restart visibility, cleanup.");
  return result;
}
