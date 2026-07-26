import { Controller, Delete, Get, HttpStatus, Inject, Param } from "@nestjs/common";

import type { NoteRecord, NoteStore } from "../notes/note.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_NOTE_STORE } from "./tokens.js";

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "note-not-found",
    "Note Not Found",
    "The requested note does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "note-persistence-failed",
    "Note Operation Failed",
    "The configured note store could not complete the operation.",
  );
}

function noteResponse(note: NoteRecord): { data: NoteRecord } {
  return { data: note };
}

/**
 * Read/remove surface only — note creation stays exclusively on the governed
 * AM-003 propose->approve->execute path (POST
 * /api/v1/projects/{projectId}/tool-actions), which is where the mandatory
 * idempotency/fingerprint contract on notes.create actually gets enforced.
 * A direct, ungoverned POST here would let any caller bypass that contract.
 */
@Controller("api/v1/projects/:projectId/notes")
export class NoteController {
  constructor(@Inject(HTTP_NOTE_STORE) private readonly notes: NoteStore) {}

  @Get()
  async list(@Param("projectId") projectId: string) {
    try {
      const data = await this.notes.list(projectId);
      return { data, count: data.length };
    } catch {
      throw operationFailed();
    }
  }

  @Get(":noteId")
  async get(@Param("projectId") projectId: string, @Param("noteId") noteId: string) {
    let note: NoteRecord | null;
    try {
      note = await this.notes.get(projectId, noteId);
    } catch {
      throw operationFailed();
    }
    if (!note) throw notFound();
    return noteResponse(note);
  }

  @Delete(":noteId")
  async remove(@Param("projectId") projectId: string, @Param("noteId") noteId: string) {
    let note: NoteRecord | null;
    try {
      note = await this.notes.remove(projectId, noteId);
    } catch {
      throw operationFailed();
    }
    if (!note) throw notFound();
    return noteResponse(note);
  }
}
