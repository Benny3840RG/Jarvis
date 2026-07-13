import { loadEnvFile } from "node:process";

import {
  exportBackup,
  readBackupFile,
  restoreBackupIntoEmptyProvider,
  verifyBackupRestore,
  writeBackupFile,
} from "../backup/backup.js";
import { createPersistenceFromEnv } from "../persistence/persistence.js";
import { redactSecret } from "./convexSmoke.js";

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npm run backup -- export <file>",
      "  npm run backup -- verify <file>",
      "  npm run backup -- restore <file> --confirm-empty-target",
      "",
      "Restore refuses a provider containing any state, tasks, or reminders.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const [command, filePath, confirmation, ...extra] = process.argv.slice(2);
  if (!command || !filePath || extra.length > 0) usage();

  if (command === "export") {
    if (confirmation !== undefined) usage();
    const archive = await exportBackup(createPersistenceFromEnv());
    await writeBackupFile(filePath, archive);
    console.log(
      `Backup written: ${filePath} (${archive.tasks.length} task(s), ${archive.reminders.length} reminder(s)).`,
    );
    return;
  }

  const archive = await readBackupFile(filePath);

  if (command === "verify") {
    if (confirmation !== undefined) usage();
    const result = await verifyBackupRestore(archive);
    console.log(
      `Backup verified in isolated storage: ${result.taskCount} task(s), ${result.reminderCount} reminder(s), assistant state restored.`,
    );
    return;
  }

  if (command === "restore") {
    if (confirmation !== "--confirm-empty-target") usage();
    const result = await restoreBackupIntoEmptyProvider(createPersistenceFromEnv(), archive);
    console.log(
      `Backup restored into empty provider: ${result.taskCount} task(s), ${result.reminderCount} reminder(s), assistant state restored.`,
    );
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  console.error("Backup command failed:", redactSecret(error, process.env.JARVIS_SERVICE_TOKEN));
  process.exitCode = 1;
});
