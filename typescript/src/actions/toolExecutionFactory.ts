import type { NoteStore } from "../notes/note.js";
import { ConvexControlledReminderStore } from "../persistence/convexControlledReminders.js";
import { ConvexControlledTaskStore } from "../persistence/convexControlledTasks.js";
import { ConvexExternalReconciliationStore } from "../persistence/convexExternalReconciliations.js";
import { ConvexNoteStore } from "../persistence/convexNotes.js";
import { ConvexToolExecutionReceiptStore } from "../persistence/convexToolExecutionReceipts.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import type { QuoteDeliveryRepository } from "../quotes/quoteDeliveryRepository.js";
import { createQuoteDeliveryRepositoryFromEnv } from "../quotes/quoteDeliveryRepositoryFactory.js";
import {
  createQuoteEmailProviderFromEnv,
  type QuoteEmailProvider,
} from "../quotes/quoteEmailProvider.js";
import { createQuoteRepositoryFromEnv } from "../quotes/quoteRepositoryFactory.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import type { ControlledReminderStore } from "../reminders/controlledReminder.js";
import type { ControlledTaskStore } from "../tasks/controlledTask.js";
import { createNoteToolDefinition } from "./createNoteTool.js";
import { createQuoteSendToolDefinition } from "./quoteSendTool.js";
import { createTaskReminderToolDefinitions } from "./taskReminderTools.js";
import { ToolExecutionService, type ToolExecutionDefinition } from "./toolExecution.js";

export function createToolExecutionDefinitions(
  noteStore: NoteStore,
  taskStore?: ControlledTaskStore,
  reminderStore?: ControlledReminderStore,
  quoteRepository?: QuoteRepository,
  quoteEmailProvider?: QuoteEmailProvider,
  quoteDeliveryRepository?: QuoteDeliveryRepository,
): ToolExecutionDefinition[] {
  if ((taskStore === undefined) !== (reminderStore === undefined)) {
    throw new Error("Task and reminder tool stores must be registered together.");
  }

  return [
    createNoteToolDefinition(noteStore),
    ...(taskStore === undefined || reminderStore === undefined
      ? []
      : createTaskReminderToolDefinitions(taskStore, reminderStore)),
    ...(quoteRepository === undefined ||
    quoteEmailProvider === undefined ||
    quoteDeliveryRepository === undefined
      ? []
      : [
          createQuoteSendToolDefinition(
            quoteRepository,
            quoteEmailProvider,
            quoteDeliveryRepository,
          ),
        ]),
  ];
}

/**
 * Tool execution remains fail-closed. The live definitions are limited to the
 * reviewed internal mutations: notes:create, tasks:create, tasks:complete,
 * reminders:create and reminders:cancel, plus quotes:send once a real email
 * provider is configured. `createQuoteEmailProviderFromEnv` currently always
 * returns `null` — no vendor has been chosen yet — so quotes:send is not
 * allowlisted in any live deployment today; every other tool:operation pair
 * is blocked as not-allowlisted by ToolExecutionService.
 */
export function createToolExecutionServiceFromEnv(): ToolExecutionService | null {
  if (resolvePersistenceProviderName() !== "convex") return null;
  return new ToolExecutionService(
    createToolExecutionDefinitions(
      new ConvexNoteStore(),
      new ConvexControlledTaskStore(),
      new ConvexControlledReminderStore(),
      createQuoteRepositoryFromEnv() ?? undefined,
      createQuoteEmailProviderFromEnv() ?? undefined,
      createQuoteDeliveryRepositoryFromEnv() ?? undefined,
    ),
    new ConvexToolExecutionReceiptStore(),
    new ConvexExternalReconciliationStore(),
  );
}
