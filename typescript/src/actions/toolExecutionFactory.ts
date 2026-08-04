import type { NoteStore } from "../notes/note.js";
import { ConvexControlledReminderStore } from "../persistence/convexControlledReminders.js";
import { ConvexControlledTaskStore } from "../persistence/convexControlledTasks.js";
import { ConvexExternalReconciliationStore } from "../persistence/convexExternalReconciliations.js";
import { ConvexNoteStore } from "../persistence/convexNotes.js";
import {
  ConvexExecutionEligibilityStore,
  ConvexSingleUseConsumptionClaimStore,
} from "../persistence/convexToolActions.js";
import { ConvexToolExecutionReceiptStore } from "../persistence/convexToolExecutionReceipts.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import type { QuoteDeliveryRepository } from "../quotes/quoteDeliveryRepository.js";
import { createQuoteDeliveryRepositoryFromEnv } from "../quotes/quoteDeliveryRepositoryFactory.js";
import {
  createQuoteEmailProviderFromEnv,
  type QuoteEmailProvider,
} from "../quotes/quoteEmailProvider.js";
import { createQuoteRepositoryFromEnv } from "../quotes/quoteRepositoryFactory.js";
import {
  createQuotePdfArtifactRepositoryFromEnv,
  type QuotePdfArtifactRepository,
} from "../quotes/quotePdfArtifactRepository.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import type { ControlledReminderStore } from "../reminders/controlledReminder.js";
import type { ControlledTaskStore } from "../tasks/controlledTask.js";
import { createNoteToolDefinition } from "./createNoteTool.js";
import { createQuoteFinalizeToolDefinition } from "./quoteFinalizeTool.js";
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
  quotePdfArtifactRepository?: QuotePdfArtifactRepository,
): ToolExecutionDefinition[] {
  if ((taskStore === undefined) !== (reminderStore === undefined)) {
    throw new Error("Task and reminder tool stores must be registered together.");
  }

  return [
    createNoteToolDefinition(noteStore),
    ...(taskStore === undefined || reminderStore === undefined
      ? []
      : createTaskReminderToolDefinitions(taskStore, reminderStore)),
    ...(quoteRepository === undefined ? [] : [createQuoteFinalizeToolDefinition(quoteRepository)]),
    ...(quoteRepository === undefined ||
    quoteEmailProvider === undefined ||
    quoteDeliveryRepository === undefined ||
    quotePdfArtifactRepository === undefined
      ? []
      : [
          createQuoteSendToolDefinition(
            quoteRepository,
            quoteEmailProvider,
            quoteDeliveryRepository,
            quotePdfArtifactRepository,
          ),
        ]),
  ];
}

/**
 * Tool execution remains fail-closed. `quotes:finalize` is registered only when
 * Convex quote persistence is available. `quotes:send` remains registered only
 * when Convex persistence and all four quote-delivery dependencies are
 * available. Maintained process entrypoints inject the provider from the same
 * Outlook runtime bundle used by reconciliation so token state is not
 * duplicated.
 */
export function createToolExecutionServiceFromEnv(
  quoteEmailProvider: QuoteEmailProvider | null = createQuoteEmailProviderFromEnv(),
): ToolExecutionService | null {
  if (resolvePersistenceProviderName() !== "convex") return null;
  return new ToolExecutionService(
    createToolExecutionDefinitions(
      new ConvexNoteStore(),
      new ConvexControlledTaskStore(),
      new ConvexControlledReminderStore(),
      createQuoteRepositoryFromEnv() ?? undefined,
      quoteEmailProvider ?? undefined,
      createQuoteDeliveryRepositoryFromEnv() ?? undefined,
      createQuotePdfArtifactRepositoryFromEnv() ?? undefined,
    ),
    new ConvexToolExecutionReceiptStore(),
    new ConvexExternalReconciliationStore(),
    new ConvexSingleUseConsumptionClaimStore(),
    new ConvexExecutionEligibilityStore(),
  );
}
