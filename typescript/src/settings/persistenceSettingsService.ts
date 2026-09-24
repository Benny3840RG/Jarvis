import fs from "node:fs/promises";

import {
  exportBackup,
  readBackupFile,
  restoreBackupIntoEmptyProvider,
  verifyBackupRestore,
  writeBackupFile,
  type BackupArchive,
  type RestoreResult,
} from "../backup/backup.js";
import { archiveFingerprint, inspectDestination } from "../backup/v4/restore.js";
import { readArchiveV4File } from "../backup/v4/archive.js";
import { coreDataFiles } from "../persistence/jarvisDataPaths.js";
import type { PersistenceProvider, PersistenceProviderName } from "../persistence/persistence.js";
import { createMemoryStoresFromEnv } from "../tools/runBackup.js";
import {
  exportArchiveV4File,
  restoreArchiveV4File,
  verifyArchiveV4File,
} from "../tools/runBackupV4.js";
import {
  buildPersistenceSettingsView,
  classifyBackupFailure,
  explainBackupFailure,
  gatePersistenceAction,
  honestV4Outcome,
  presentFailureDetail,
  reconcileProvider,
  type ClassicCounts,
  type DestinationInspection,
  type PersistenceActionInput,
  type PersistenceActionResult,
  type PersistenceHealth,
  type PersistenceSettingsView,
  type V4Outcome,
} from "./persistenceSettings.js";

/**
 * JARVIS-006: executes the existing backup library. It does not select a
 * provider, merge archives, or resume a restore unless the action says so.
 */
export type PersistenceSettingsPorts = {
  probe: () => Promise<Pick<PersistenceHealth, "state" | "status" | "detail">>;
  exportClassic: (file: string) => Promise<ClassicCounts>;
  verifyClassic: (file: string) => Promise<ClassicCounts>;
  restoreClassic: (file: string) => Promise<ClassicCounts>;
  exportV4: (file: string) => Promise<V4Outcome>;
  verifyV4: (file: string) => Promise<V4Outcome>;
  restoreV4: (
    file: string,
    destination: string,
    flags: { allowPartial: boolean; resume: boolean },
  ) => Promise<V4Outcome>;
  inspectV4Destination: (file: string, destination: string) => Promise<DestinationInspection>;
};

export type PersistenceSettingsServiceOptions = {
  runningProvider: PersistenceProviderName;
  env?: NodeJS.ProcessEnv;
  jsonStatePath?: string;
  now?: () => Date;
  secrets?: Array<string | undefined>;
  ports: PersistenceSettingsPorts;
};

function countsFromArchive(archive: BackupArchive): ClassicCounts {
  return {
    tasks: archive.tasks.length,
    reminders: archive.reminders.length,
    builds: archive.builds.length,
    buildLogs: archive.buildLogs.length,
    upgrades: archive.upgrades.length,
    assets: archive.assets.length,
    preferences: archive.preferences.length,
  };
}

function countsFromRestore(result: RestoreResult): ClassicCounts {
  return {
    tasks: result.taskCount,
    reminders: result.reminderCount,
    builds: result.buildCount,
    buildLogs: result.buildLogCount,
    upgrades: result.upgradeCount,
    assets: result.assetCount,
    preferences: result.preferenceCount,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    return true;
  }
}

export async function inspectJsonLock(
  statePath: string,
): Promise<{ state: "ok" | "degraded"; detail: string | null }> {
  const lockPath = `${statePath}.lock`;
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return { state: "ok", detail: null };
    return {
      state: "degraded",
      detail:
        "Jarvis JSON state lock could not be read. Close the other local writer or select Convex for multi-process use.",
    };
  }
  let pid: number | null = null;
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) {
      pid = parsed.pid;
    }
  } catch {
    pid = null;
  }
  if (pid !== null && !processAlive(pid)) return { state: "ok", detail: null };
  const owner = pid === null ? "a malformed lock file" : `process ${pid}`;
  return {
    state: "degraded",
    detail: `Jarvis JSON state is locked by ${owner}. Close the other local writer or select Convex for multi-process use.`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDefaultPersistenceSettingsPorts(input: {
  persistence: PersistenceProvider;
  runningProvider: PersistenceProviderName;
  jsonStatePath: string;
  secrets: Array<string | undefined>;
}): PersistenceSettingsPorts {
  const secrets = input.secrets;
  return {
    async probe() {
      if (input.runningProvider === "json") {
        try {
          await fs.access(input.jsonStatePath, fs.constants.R_OK);
        } catch (error: unknown) {
          if (!(isNodeError(error) && error.code === "ENOENT")) {
            return {
              state: "fail-closed",
              status: "JSON state file is not readable",
              detail: presentFailureDetail(errorMessage(error), secrets),
            };
          }
        }
      }
      try {
        await input.persistence.loadState();
      } catch (error: unknown) {
        return {
          state: "fail-closed",
          status: "Unreachable",
          detail: presentFailureDetail(errorMessage(error), secrets),
        };
      }
      if (input.runningProvider === "json") {
        const lock = await inspectJsonLock(input.jsonStatePath);
        if (lock.state === "degraded") {
          return { state: "degraded", status: "Lock contention", detail: lock.detail };
        }
        return { state: "ok", status: "State file readable", detail: null };
      }
      return { state: "ok", status: "Reachable · token accepted", detail: null };
    },
    async exportClassic(file) {
      const archive = await exportBackup(
        input.persistence,
        () => new Date(),
        createMemoryStoresFromEnv(),
      );
      await writeBackupFile(file, archive);
      return countsFromArchive(archive);
    },
    async verifyClassic(file) {
      return countsFromRestore(await verifyBackupRestore(await readBackupFile(file)));
    },
    async restoreClassic(file) {
      return countsFromRestore(
        await restoreBackupIntoEmptyProvider(
          input.persistence,
          await readBackupFile(file),
          createMemoryStoresFromEnv(),
        ),
      );
    },
    async exportV4(file) {
      return honestV4Outcome((await exportArchiveV4File(file)).manifest);
    },
    async verifyV4(file) {
      return honestV4Outcome((await verifyArchiveV4File(file)).manifest);
    },
    async restoreV4(file, destination, flags) {
      const restored = await restoreArchiveV4File(
        file,
        destination,
        flags.allowPartial,
        flags.resume,
      );
      return honestV4Outcome(restored.archive.manifest);
    },
    async inspectV4Destination(file, destination) {
      try {
        const state = await inspectDestination(destination);
        if (state.kind === "fresh") {
          return {
            kind: "fresh",
            resumeAvailable: false,
            detail: "Destination does not exist. A restore can create it. Resume is not implied.",
          };
        }
        if (state.kind === "completed") {
          return {
            kind: "completed",
            resumeAvailable: false,
            detail: "Destination already holds a completed restore. Use a new destination.",
          };
        }
        if (state.kind === "foreign") {
          return {
            kind: "foreign",
            resumeAvailable: false,
            detail: "Destination exists and was not written by a restore. Refusing to merge.",
          };
        }
        const archive = await readArchiveV4File(file);
        const same = state.marker.archiveFingerprint === archiveFingerprint(archive);
        return same
          ? {
              kind: "interrupted-same",
              resumeAvailable: true,
              detail:
                "Destination holds an interrupted restore of this archive. Resume only with the explicit resume action (--resume).",
            }
          : {
              kind: "interrupted-other",
              resumeAvailable: false,
              detail: "Destination holds an interrupted restore of a different archive.",
            };
      } catch (error: unknown) {
        return {
          kind: "error",
          resumeAvailable: false,
          detail: presentFailureDetail(errorMessage(error), secrets),
        };
      }
    },
  };
}

export class PersistenceSettingsService {
  constructor(private readonly options: PersistenceSettingsServiceOptions) {}

  private secrets(): Array<string | undefined> {
    return this.options.secrets ?? [];
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  async read(): Promise<PersistenceSettingsView> {
    const now = (this.options.now ?? (() => new Date()))();
    const reconciliation = reconcileProvider(
      this.env().PERSISTENCE_PROVIDER,
      this.options.runningProvider,
    );
    const jsonStatePath = this.options.jsonStatePath ?? coreDataFiles.state;
    let health: PersistenceHealth;
    if (reconciliation.kind === "misconfigured") {
      health = {
        state: "fail-closed",
        status: "Provider misconfigured",
        checkedAt: now.toISOString(),
        detail: presentFailureDetail(reconciliation.detail, this.secrets()),
      };
    } else {
      const probed = await this.options.ports.probe();
      health = { ...probed, checkedAt: now.toISOString() };
    }
    const deployment = this.env().CONVEX_DEPLOYMENT?.trim() || null;
    return buildPersistenceSettingsView({
      reconciliation,
      health,
      convexDeployment: deployment,
      jsonStatePath,
      now,
    });
  }

  async run(input: PersistenceActionInput): Promise<PersistenceActionResult> {
    const view = await this.read();
    const gate = gatePersistenceAction(view, input);
    const base = {
      action: input.action,
      path: input.file?.trim() || null,
      counts: null,
      v4: null,
      destination: null,
      verifyRecommended: false,
    };
    if (!gate.ok) {
      return { ...base, status: "refused", code: gate.code, detail: gate.detail };
    }
    try {
      return await this.execute(input, base);
    } catch (error: unknown) {
      const message = explainBackupFailure(
        presentFailureDetail(errorMessage(error), this.secrets()),
      );
      return {
        ...base,
        status: "failed",
        code: classifyBackupFailure(message),
        detail: message,
      };
    }
  }

  private async execute(
    input: PersistenceActionInput,
    base: Omit<PersistenceActionResult, "status" | "code" | "detail">,
  ): Promise<PersistenceActionResult> {
    const file = input.file?.trim() ?? "";
    const destination = input.destination?.trim() ?? "";
    const ports = this.options.ports;
    if (input.action === "export-classic") {
      const counts = await ports.exportClassic(file);
      return {
        ...base,
        status: "completed",
        code: null,
        counts,
        verifyRecommended: true,
        detail: `Backup written: ${file}. Verify recommended. Private permissions; an existing file is not overwritten.`,
      };
    }
    if (input.action === "verify-classic") {
      const counts = await ports.verifyClassic(file);
      return {
        ...base,
        status: "completed",
        code: null,
        counts,
        detail: `Backup verified in isolated temporary JSON. Live provider was not modified. ${counts.tasks} task(s), ${counts.reminders} reminder(s), ${counts.builds} build(s), ${counts.buildLogs} build log(s), ${counts.upgrades} upgrade(s), ${counts.assets} asset(s), ${counts.preferences} preference(s).`,
      };
    }
    if (input.action === "restore-classic") {
      const counts = await ports.restoreClassic(file);
      return {
        ...base,
        status: "completed",
        code: null,
        counts,
        detail: `Backup restored into an empty provider (--confirm-empty-target). ${counts.tasks} task(s), ${counts.reminders} reminder(s). IDs and timestamps were recreated.`,
      };
    }
    if (input.action === "export-v4") {
      const v4 = await ports.exportV4(file);
      return {
        ...base,
        status: "completed",
        code: null,
        v4,
        verifyRecommended: true,
        detail: `Archive v4 written: ${file}. ${v4.headline} Unresolved references: ${v4.unresolvedReferenceCount}. Verify recommended.`,
      };
    }
    if (input.action === "verify-v4") {
      const v4 = await ports.verifyV4(file);
      return {
        ...base,
        status: "completed",
        code: null,
        v4,
        detail: `Archive v4 verified in a throwaway directory. Live storage was not modified. ${v4.headline}`,
      };
    }
    if (input.action === "inspect-v4-destination") {
      const inspected = await ports.inspectV4Destination(file, destination);
      return {
        ...base,
        status: "completed",
        code: null,
        destination: inspected,
        detail: inspected.detail,
      };
    }
    const v4 = await ports.restoreV4(file, destination, {
      allowPartial: true,
      resume: input.action === "resume-v4",
    });
    return {
      ...base,
      status: "completed",
      code: null,
      v4,
      path: destination,
      detail:
        input.action === "resume-v4"
          ? `Archive v4 restore resumed with --allow-partial --resume. ${v4.headline} This is not a complete backup.`
          : `Archive v4 restored with --allow-partial. Resume was not used. ${v4.headline} This is not a complete backup.`,
    };
  }
}

export function createPersistenceSettingsService(input: {
  persistence: PersistenceProvider;
  runningProvider: PersistenceProviderName;
  env?: NodeJS.ProcessEnv;
  jsonStatePath?: string;
  now?: () => Date;
  secrets?: Array<string | undefined>;
  ports?: PersistenceSettingsPorts;
}): PersistenceSettingsService {
  const jsonStatePath = input.jsonStatePath ?? coreDataFiles.state;
  const secrets = input.secrets ?? [
    input.env?.JARVIS_SERVICE_TOKEN ?? process.env.JARVIS_SERVICE_TOKEN,
  ];
  return new PersistenceSettingsService({
    runningProvider: input.runningProvider,
    env: input.env,
    jsonStatePath,
    now: input.now,
    secrets,
    ports:
      input.ports ??
      createDefaultPersistenceSettingsPorts({
        persistence: input.persistence,
        runningProvider: input.runningProvider,
        jsonStatePath,
        secrets,
      }),
  });
}
