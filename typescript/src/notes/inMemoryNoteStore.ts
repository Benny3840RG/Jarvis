import type { CreateNoteInput, NoteRecord, NoteStore } from "./note.js";

function cloneNote(note: NoteRecord): NoteRecord {
  return { ...note, tags: [...note.tags] };
}

/**
 * In-memory NoteStore for tests and default HTTP wiring only; nothing is
 * persisted. Notes have no JSON-file store — per the AM-003 commissioning
 * plan (issue #150), notes use only the Convex-backed persistence boundary
 * in any real deployment. This class exists solely for the same reason the
 * other memory domains have one: so `createJarvisHttpApp` has a store to use
 * when no environment/persistence is configured at all (contract tests).
 */
export class InMemoryNoteStore implements NoteStore {
  private readonly notes = new Map<string, NoteRecord>();
  private revisionSeq = 0;

  create(input: CreateNoteInput): Promise<NoteRecord> {
    const now = Date.now();
    const note: NoteRecord = {
      id: `note-${++this.revisionSeq}`,
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
    };
    this.notes.set(note.id, note);
    return Promise.resolve(cloneNote(note));
  }

  get(projectId: string, id: string): Promise<NoteRecord | null> {
    const note = this.notes.get(id);
    return Promise.resolve(note && note.projectId === projectId ? cloneNote(note) : null);
  }

  list(projectId: string, limit?: number): Promise<NoteRecord[]> {
    const matches = [...this.notes.values()]
      .filter((note) => note.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return Promise.resolve(
      (limit === undefined ? matches : matches.slice(0, limit)).map(cloneNote),
    );
  }

  remove(projectId: string, id: string): Promise<NoteRecord | null> {
    const note = this.notes.get(id);
    if (!note || note.projectId !== projectId) return Promise.resolve(null);
    this.notes.delete(id);
    return Promise.resolve(cloneNote(note));
  }
}
