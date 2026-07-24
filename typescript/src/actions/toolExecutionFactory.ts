import type { NoteStore } from "../notes/note.js";
import { ConvexNoteStore } from "../persistence/convexNotes.js";
import { ConvexToolExecutionReceiptStore } from "../persistence/convexToolExecutionReceipts.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import { createNoteToolDefinition } from "./createNoteTool.js";
import { ToolExecutionService, type ToolExecutionDefinition } from "./toolExecution.js";

export function createToolExecutionDefinitions(noteStore: NoteStore): ToolExecutionDefinition[] {
  return [createNoteToolDefinition(noteStore)];
}

/**
 * Tool execution remains fail-closed. The only live definition is the reviewed
 * internal AM-003 `notes:create` mutation; every other tool:operation pair is
 * blocked as not-allowlisted by ToolExecutionService.
 */
export function createToolExecutionServiceFromEnv(): ToolExecutionService | null {
  if (resolvePersistenceProviderName() !== "convex") return null;
  return new ToolExecutionService(
    createToolExecutionDefinitions(new ConvexNoteStore()),
    new ConvexToolExecutionReceiptStore(),
  );
}
