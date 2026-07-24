import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CreateNoteInput, NoteRecord, NoteStore } from "../src/notes/note.js";
import { runNotesSmoke } from "../src/tools/notesSmoke.js";

type SharedState = {
  notes: Map<string, NoteRecord & { idempotencyKey: string; actionFingerprint: string }>;
  listFailure?: Error;
};

class SharedNoteStore implements NoteStore {
  constructor(private readonly state: SharedState) {}

  async create(input: CreateNoteInput): Promise<NoteRecord> {
    const existing = [...this.state.notes.values()].find(
      (note) => note.projectId === input.projectId && note.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      if (existing.actionFingerprint !== input.actionFingerprint) {
        throw new Error("fingerprint conflict");
      }
      return existing;
    }

    const now = 1_785_000_000_000;
    const note: NoteRecord & { idempotencyKey: string; actionFingerprint: string } = {
      id: `note-${this.state.notes.size + 1}`,
      projectId: input.projectId,
      title: input.title,
      body: input.body,
      tags: [...input.tags],
      domain: input.domain,
      sensitivity: input.sensitivity,
      retention: input.retention,
      sourceRequestId: input.sourceRequestId,
      correlationId: input.correlationId,
      source: input.source,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint: input.actionFingerprint,
    };
    this.state.notes.set(note.id, note);
    return note;
  }

  async get(projectId: string, id: string): Promise<NoteRecord | null> {
    const note = this.state.notes.get(id);
    return note?.projectId === projectId ? note : null;
  }

  async list(projectId: string): Promise<NoteRecord[]> {
    if (this.state.listFailure) {
      const error = this.state.listFailure;
      this.state.listFailure = undefined;
      throw error;
    }
    return [...this.state.notes.values()].filter((note) => note.projectId === projectId);
  }

  async remove(projectId: string, id: string): Promise<NoteRecord | null> {
    const note = this.state.notes.get(id);
    if (!note || note.projectId !== projectId) return null;
    this.state.notes.delete(id);
    return note;
  }
}

describe("notes development smoke", () => {
  it("proves replay, fresh-store visibility and cleanup", async () => {
    const state: SharedState = { notes: new Map() };
    const messages: string[] = [];

    const result = await runNotesSmoke(
      () => new SharedNoteStore(state),
      "dev:outgoing-ram-798",
      (message) => messages.push(message),
    );

    assert.deepEqual(result, {
      created: true,
      replayed: true,
      restartVisible: true,
      removed: true,
    });
    assert.equal(state.notes.size, 0);
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", /create, idempotent replay, restart visibility, cleanup/);
  });

  it("cleans up a created note when a later smoke stage fails", async () => {
    const state: SharedState = {
      notes: new Map(),
      listFailure: new Error("simulated list failure"),
    };

    await assert.rejects(
      runNotesSmoke(() => new SharedNoteStore(state), "dev:outgoing-ram-798"),
      /simulated list failure/,
    );
    assert.equal(state.notes.size, 0);
  });

  it("refuses any non-development deployment before touching the store", async () => {
    let factoryCalls = 0;
    await assert.rejects(
      runNotesSmoke(() => {
        factoryCalls += 1;
        return new SharedNoteStore({ notes: new Map() });
      }, "prod:jarvis"),
      /must identify a development deployment/,
    );
    assert.equal(factoryCalls, 0);
  });
});
