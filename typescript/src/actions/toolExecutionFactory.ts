import { createSecurityEducationTools } from "./securityEducation.js";
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
import { createErrandToolDefinitions } from "./errandTools.js";
import type { ErrandStore } from "../errands/errand.js";
import { JsonErrandStore } from "../errands/jsonErrandStore.js";
import {
  createGitHubDevelopmentClientFromEnv,
  createGitHubMergeToolDefinition,
  type GitHubDevelopmentClient,
} from "../development/githubDevelopment.js";
import { createQuoteFinalizeToolDefinition } from "./quoteFinalizeTool.js";
import { createHomeAnnouncementToolDefinition } from "./homeAnnouncementTool.js";
import {
  createGoogleHomeAnnouncementProviderFromEnv,
  type GoogleHomeAnnouncementProvider,
} from "../integrations/googleHome/googleHomeAnnouncementProvider.js";
import { createDeviceToolDefinitionsFromEnv } from "../devices/googleCastDeviceAdapter.js";
import { createQuoteSendToolDefinition } from "./quoteSendTool.js";
import {
  createTaskReminderToolDefinitions,
  reminderRescheduleEnabledFromEnv,
} from "./taskReminderTools.js";
import { ToolExecutionService, type ToolExecutionDefinition } from "./toolExecution.js";

export function createToolExecutionDefinitions(
  noteStore: NoteStore,
  taskStore?: ControlledTaskStore,
  reminderStore?: ControlledReminderStore,
  quoteRepository?: QuoteRepository,
  quoteEmailProvider?: QuoteEmailProvider,
  quoteDeliveryRepository?: QuoteDeliveryRepository,
  quotePdfArtifactRepository?: QuotePdfArtifactRepository,
  githubDevelopmentClient?: GitHubDevelopmentClient,
  googleHomeAnnouncementProvider?: GoogleHomeAnnouncementProvider,
  errandStore?: ErrandStore,
  options: {
    reminderReschedule?: boolean;
    /** Governed device-registry tools (#836); empty unless bindings are configured. */
    deviceTools?: readonly ToolExecutionDefinition[];
  } = {},
): ToolExecutionDefinition[] {
  if ((taskStore === undefined) !== (reminderStore === undefined)) {
    throw new Error("Task and reminder tool stores must be registered together.");
  }

  return [
    createNoteToolDefinition(noteStore),
    ...createSecurityEducationTools(),
    ...(taskStore === undefined || reminderStore === undefined
      ? []
      : createTaskReminderToolDefinitions(taskStore, reminderStore, options)),
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
    ...(githubDevelopmentClient === undefined
      ? []
      : [createGitHubMergeToolDefinition(githubDevelopmentClient)]),
    ...(googleHomeAnnouncementProvider === undefined
      ? []
      : [createHomeAnnouncementToolDefinition(googleHomeAnnouncementProvider)]),
    ...(errandStore === undefined ? [] : createErrandToolDefinitions(errandStore)),
    ...(options.deviceTools ?? []),
  ];
}

/**
 * Tool execution remains fail-closed. `quotes:finalize` is registered only when
 * Convex quote persistence is available. `quotes:send` remains registered only
 * when Convex persistence and all four quote-delivery dependencies are
 * available. Maintained process entrypoints inject the provider from the same
 * Outlook runtime bundle used by reconciliation so token state is not
 * duplicated. `reminders:reschedule` (AM-017, planned) is registered only when
 * JARVIS_REMINDER_RESCHEDULE_ENABLED is "true". `errands:create` writes the same local JSON errand file the HTTP
 * errand routes use (its file lock is cross-process). `device:announce` (#836) is
 * registered only when JARVIS_DEVICE_BINDINGS_JSON is set; invalid bindings refuse startup.
 */
export function createToolExecutionServiceFromEnv(
  quoteEmailProvider: QuoteEmailProvider | null = createQuoteEmailProviderFromEnv(),
  githubDevelopmentClient: GitHubDevelopmentClient | null = createGitHubDevelopmentClientFromEnv(),
  googleHomeAnnouncementProvider: GoogleHomeAnnouncementProvider | null = createGoogleHomeAnnouncementProviderFromEnv(),
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
      githubDevelopmentClient ?? undefined,
      googleHomeAnnouncementProvider ?? undefined,
      new JsonErrandStore(),
      {
        reminderReschedule: reminderRescheduleEnabledFromEnv(),
        deviceTools: createDeviceToolDefinitionsFromEnv(
          googleHomeAnnouncementProvider ?? undefined,
        ),
      },
    ),
    new ConvexToolExecutionReceiptStore(),
    new ConvexExternalReconciliationStore(),
    new ConvexSingleUseConsumptionClaimStore(),
    new ConvexExecutionEligibilityStore(),
  );
}
