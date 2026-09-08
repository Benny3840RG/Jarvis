import { loadEnvFile } from "node:process";

import {
  exportBackup,
  readBackupFile,
  restoreBackupIntoEmptyProvider,
  verifyBackupRestore,
  writeBackupFile,
  type BackupMemoryStores,
} from "../backup/backup.js";
import { createPersistenceFromEnv } from "../persistence/persistence.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import { JsonBuildStore } from "../builds/jsonBuildStore.js";
import { ConvexBuildStore } from "../builds/convexBuildStore.js";
import { JsonBuildLogStore } from "../buildLog/jsonBuildLogStore.js";
import { ConvexBuildLogStore } from "../buildLog/convexBuildLogStore.js";
import { JsonUpgradeStore } from "../upgrades/jsonUpgradeStore.js";
import { ConvexUpgradeStore } from "../upgrades/convexUpgradeStore.js";
import { JsonAssetStore } from "../assets/jsonAssetStore.js";
import { ConvexAssetStore } from "../assets/convexAssetStore.js";
import { JsonPreferenceStore } from "../preferences/jsonPreferenceStore.js";
import { ConvexPreferenceStore } from "../preferences/convexPreferenceStore.js";
import { redactSecret } from "./convexSmoke.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

/**
 * Builds/build logs/upgrades/assets/preferences, wired to whichever provider
 * PERSISTENCE_PROVIDER selects — the same "memory store" bundle used by
 * `npm run import:convex`. Every other durable-memory domain (clients, quotes,
 * invoices, projects, ...) is still outside backup's reach; see the backup
 * module's BackupMemoryStores doc comment and typescript/docs/ROADMAP.md.
 */
function createMemoryStoresFromEnv(): BackupMemoryStores {
  return resolvePersistenceProviderName() === "convex"
    ? {
        builds: new ConvexBuildStore(),
        buildLogs: new ConvexBuildLogStore(),
        upgrades: new ConvexUpgradeStore(),
        assets: new ConvexAssetStore(),
        preferences: new ConvexPreferenceStore(),
      }
    : {
        builds: new JsonBuildStore(),
        buildLogs: new JsonBuildLogStore(),
        upgrades: new JsonUpgradeStore(),
        assets: new JsonAssetStore(),
        preferences: new JsonPreferenceStore(),
      };
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npm run backup -- export <file>",
      "  npm run backup -- verify <file>",
      "  npm run backup -- restore <file> --confirm-empty-target",
      "",
      "Covers state, tasks, reminders, builds, build logs, upgrades, assets, and",
      "preferences. Restore refuses a target where any of those already hold data.",
      "Every other durable-memory domain (clients, quotes, invoices, projects, ...)",
      "is not yet covered — see typescript/docs/ROADMAP.md.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const [command, filePath, confirmation, ...extra] = process.argv.slice(2);
  if (!command || !filePath || extra.length > 0) usage();

  if (command === "export") {
    if (confirmation !== undefined) usage();
    const archive = await exportBackup(createPersistenceFromEnv(), createMemoryStoresFromEnv());
    await writeBackupFile(filePath, archive);
    console.log(
      `Backup written: ${filePath} (${archive.tasks.length} task(s), ${archive.reminders.length} reminder(s), ` +
        `${archive.builds.length} build(s), ${archive.buildLogs.length} build log(s), ` +
        `${archive.upgrades.length} upgrade(s), ${archive.assets.length} asset(s), ` +
        `${archive.preferences.length} preference(s)).`,
    );
    return;
  }

  const archive = await readBackupFile(filePath);

  if (command === "verify") {
    if (confirmation !== undefined) usage();
    const result = await verifyBackupRestore(archive);
    console.log(
      `Backup verified in isolated storage: ${result.taskCount} task(s), ${result.reminderCount} reminder(s), ` +
        `${result.buildCount} build(s), ${result.buildLogCount} build log(s), ${result.upgradeCount} upgrade(s), ` +
        `${result.assetCount} asset(s), ${result.preferenceCount} preference(s), assistant state restored.`,
    );
    return;
  }

  if (command === "restore") {
    if (confirmation !== "--confirm-empty-target") usage();
    const result = await restoreBackupIntoEmptyProvider(
      createPersistenceFromEnv(),
      archive,
      createMemoryStoresFromEnv(),
    );
    console.log(
      `Backup restored into empty provider: ${result.taskCount} task(s), ${result.reminderCount} reminder(s), ` +
        `${result.buildCount} build(s), ${result.buildLogCount} build log(s), ${result.upgradeCount} upgrade(s), ` +
        `${result.assetCount} asset(s), ${result.preferenceCount} preference(s), assistant state restored.`,
    );
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  console.error("Backup command failed:", redactSecret(error, process.env.JARVIS_SERVICE_TOKEN));
  process.exitCode = 1;
});
