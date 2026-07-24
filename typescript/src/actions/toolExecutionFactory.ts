import type { NoteStore } from "../notes/note.js";
import { ConvexControlledReminderStore } from "../persistence/convexControlledReminders.js";
import { ConvexControlledTaskStore } from "../persistence/convexControlledTasks.js";
import { ConvexNoteStore } from "../persistence/convexNotes.js";
import { ConvexToolExecutionReceiptStore } from "../persistence/convexToolExecutionReceipts.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import type { ControlledReminderStore } from "../reminders/controlledReminder.js";
import type { ControlledTaskStore } from "../tasks/controlledTask.js";
import { createNoteToolDefinition } from "./createNoteTool.js";
import { createTaskReminderToolDefinitions } from "./taskReminderTools.js";
import { ToolExecutionService, type ToolExecutionDefinition } from "./toolExecution.js";

export function createToolExecutionDefinitions(
  noteStore: NoteStore,
  taskStore?: ControlledTaskStore,
  reminderStore?: ControlledReminderStore,
): ToolExecutionDefinition[] {
  if ((taskStore === undefined) !== (reminderStore === undefined)) {
    throw new Error("Task and reminder tool stores must be registered together.");
  }

  return [
    createNoteToolDefinition(noteStore),
    ...(taskStore === undefined || reminderStore === undefined
      ? []
      : createTaskReminderToolDefinitions(taskStore, reminderStore)),
  ];
}

/**
 * Tool execution remains fail-closed. The live definitions are limited to the
 * reviewed internal mutations: notes:create, tasks:create, tasks:complete,
 * reminders:create and reminders:cancel. Every other tool:operation pair is
 * blocked as not-allowlisted by ToolExecutionService.
 */
export function createToolExecutionServiceFromEnv(): ToolExecutionService | null {
  if (resolvePersistenceProviderName() !== "convex") return null;
  return new ToolExecutionService(
    createToolExecutionDefinitions(
      new ConvexNoteStore(),
      new ConvexControlledTaskStore(),
      new ConvexControlledReminderStore(),
    ),
    new ConvexToolExecutionReceiptStore(),
  );
}
