import { loadEnvFile } from "node:process";

import { ConvexAssetStore } from "../assets/convexAssetStore.js";
import { ConvexBuildLogStore } from "../buildLog/convexBuildLogStore.js";
import { ConvexBuildStore } from "../builds/convexBuildStore.js";
import { ConvexControlledReminderStore } from "../persistence/convexControlledReminders.js";
import { ConvexControlledTaskStore } from "../persistence/convexControlledTasks.js";
import { ConvexExternalReconciliationStore } from "../persistence/convexExternalReconciliations.js";
import { ConvexNoteStore } from "../persistence/convexNotes.js";
import { ConvexQuoteDeliveryRepository } from "../persistence/convexQuoteDeliveries.js";
import { ConvexPersistence } from "../persistence/persistence.js";
import { ConvexPreferenceStore } from "../preferences/convexPreferenceStore.js";
import { ConvexUpgradeStore } from "../upgrades/convexUpgradeStore.js";
import { ConvexQuoteRepository } from "../quotes/convexQuoteRepository.js";
import { redactSecret, runConvexSmoke } from "./convexSmoke.js";
import { runExternalReconciliationSmoke } from "./externalReconciliationSmoke.js";
import { runMemoryStoresSmoke } from "./memoryStoresSmoke.js";
import { runNotesSmoke } from "./notesSmoke.js";
import { runQuoteLifecycleSmoke } from "./quoteLifecycleSmoke.js";
import { runTaskReminderActionsSmoke } from "./taskReminderActionsSmoke.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const deployment = process.env.CONVEX_DEPLOYMENT;
  await runConvexSmoke(() => new ConvexPersistence(), deployment);
  await runMemoryStoresSmoke(
    {
      builds: () => new ConvexBuildStore(),
      buildLogs: () => new ConvexBuildLogStore(),
      upgrades: () => new ConvexUpgradeStore(),
      assets: () => new ConvexAssetStore(),
      preferences: () => new ConvexPreferenceStore(),
    },
    deployment,
  );
  await runNotesSmoke(() => new ConvexNoteStore(), deployment);
  await runTaskReminderActionsSmoke(
    () => new ConvexControlledTaskStore(),
    () => new ConvexControlledReminderStore(),
    deployment,
  );
  await runExternalReconciliationSmoke(() => new ConvexExternalReconciliationStore(), deployment);
  await runQuoteLifecycleSmoke(
    () => new ConvexQuoteRepository(),
    () => new ConvexQuoteDeliveryRepository(),
    deployment,
  );
}

main().catch((error: unknown) => {
  console.error("Convex smoke failed:", redactSecret(error, process.env.JARVIS_SERVICE_TOKEN));
  process.exitCode = 1;
});
