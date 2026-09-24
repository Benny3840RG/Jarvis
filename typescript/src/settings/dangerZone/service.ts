import os from "node:os";
import path from "node:path";

import { JARVIS_DATA_DIR } from "../../persistence/jarvisDataPaths.js";
import { resolvePersistenceProviderName } from "../../persistence/providerSelection.js";
import { appendDangerZoneAudit, type DangerZoneAuditRecord } from "./audit.js";
import { assertVerifiedBackup, findRecentVerifiedBackup } from "./backupReceipt.js";
import {
  AUDIT_BASENAME,
  basenamesFor,
  buildDangerZoneModel,
  type CredentialFacts,
  type DangerZoneModel,
  type DangerZoneProvider,
  type VerifyState,
} from "./catalog.js";
import {
  confirmationMatches,
  DANGER_ZONE_CONFIRM,
  dangerZoneCardHref,
  isOverlapActionId,
  OVERLAP_PREVIOUS_ENV,
  type DangerZoneActionId,
} from "./confirm.js";
import {
  removeConvexPreviousEnv,
  removeLocalEnvAssignment,
  spawnConvexCommand,
  type CommandRunner,
} from "./convexEnv.js";
import { DangerZoneRefusal } from "./errors.js";
import { redactSecrets, tokenFingerprint } from "./fingerprint.js";
import { quarantineNamedFiles } from "./quarantine.js";

const CURRENT_ENV = {
  "end-service-overlap": "JARVIS_SERVICE_TOKEN",
  "end-approval-overlap": "JARVIS_APPROVAL_TOKEN",
  "end-delivery-overlap": "JARVIS_DELIVERY_RUNTIME_TOKEN",
} as const;

export type DangerZoneBackupChoice =
  { mode: "verified"; path: string } | { mode: "skip"; acceptIrreversibleLoss: boolean };

export type DangerZoneActionRequest = {
  confirmation: string;
  acceptEmptyLocalCore?: boolean;
  backup?: DangerZoneBackupChoice;
};

export type DangerZoneActionResult = {
  actionId: DangerZoneActionId;
  outcome: "success";
  detail: string;
  convexDataDeletes: 0;
  quarantinedPaths: string[];
  overlap: "off" | null;
  audit: DangerZoneAuditRecord;
};

export type DangerZoneServiceOptions = {
  dataDir: string;
  provider: DangerZoneProvider;
  env: NodeJS.ProcessEnv;
  localEnvPath: string;
  backupDirectories: readonly string[];
  convexCwd: string;
  runConvexCommand?: CommandRunner;
  lockTimeoutMs?: number;
  now?: () => Date;
  hostname?: string;
  pid?: number;
  lastVerify?: VerifyState;
  log?: (line: string) => void;
};

function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function secretsIn(env: NodeJS.ProcessEnv): string[] {
  return [
    "JARVIS_SERVICE_TOKEN",
    "JARVIS_SERVICE_TOKEN_PREVIOUS",
    "JARVIS_APPROVAL_TOKEN",
    "JARVIS_APPROVAL_TOKEN_PREVIOUS",
    "JARVIS_DELIVERY_RUNTIME_TOKEN",
    "JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS",
  ]
    .map((name) => readSecret(env, name))
    .filter((secret): secret is string => secret !== undefined);
}

export class DangerZoneService {
  private readonly running = new Set<DangerZoneActionId>();

  constructor(private readonly options: DangerZoneServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private facts(): CredentialFacts {
    const serviceCurrent = readSecret(this.options.env, CURRENT_ENV["end-service-overlap"]);
    const servicePrevious = readSecret(
      this.options.env,
      OVERLAP_PREVIOUS_ENV["end-service-overlap"],
    );
    const approvalCurrent = readSecret(this.options.env, CURRENT_ENV["end-approval-overlap"]);
    const approvalPrevious = readSecret(
      this.options.env,
      OVERLAP_PREVIOUS_ENV["end-approval-overlap"],
    );
    const deliveryCurrent = readSecret(this.options.env, CURRENT_ENV["end-delivery-overlap"]);
    const deliveryPrevious = readSecret(
      this.options.env,
      OVERLAP_PREVIOUS_ENV["end-delivery-overlap"],
    );
    return {
      serviceOverlap: servicePrevious === undefined ? "off" : "on",
      serviceFingerprint: tokenFingerprint(serviceCurrent),
      approvalOverlap: approvalPrevious === undefined ? "off" : "on",
      approvalFingerprint: tokenFingerprint(approvalCurrent),
      deliveryConfigured: deliveryCurrent !== undefined,
      deliveryOverlap: deliveryPrevious === undefined ? "off" : "on",
      deliveryFingerprint: tokenFingerprint(deliveryCurrent),
      lastVerify: this.options.lastVerify ?? "not-run",
    };
  }

  async inspect(): Promise<DangerZoneModel> {
    const verifiedBackup = await findRecentVerifiedBackup({
      directories: this.options.backupDirectories,
      dataDir: this.options.dataDir,
      now: this.now(),
    });
    return buildDangerZoneModel({
      provider: this.options.provider,
      facts: this.facts(),
      verifiedBackup,
      dataDir: this.options.dataDir,
      credentialsEndOverlapHref: dangerZoneCardHref("end-service-overlap"),
    });
  }

  async execute(
    actionId: DangerZoneActionId,
    request: DangerZoneActionRequest,
  ): Promise<DangerZoneActionResult> {
    if (this.running.has(actionId)) {
      throw new DangerZoneRefusal(
        "in-flight",
        "This Danger zone action is already running. Wait for it to finish.",
      );
    }
    this.running.add(actionId);
    try {
      return await this.executeUnlocked(actionId, request);
    } catch (error: unknown) {
      if (error instanceof DangerZoneRefusal) {
        throw new DangerZoneRefusal(
          error.code,
          redactSecrets(error.message, secretsIn(this.options.env)),
        );
      }
      this.options.log?.(
        redactSecrets(
          error instanceof Error ? error.message : "Danger zone action failed.",
          secretsIn(this.options.env),
        ),
      );
      throw new DangerZoneRefusal(
        "permission",
        "Danger zone action failed before any credential or Convex data change.",
      );
    } finally {
      this.running.delete(actionId);
    }
  }

  private async executeUnlocked(
    actionId: DangerZoneActionId,
    request: DangerZoneActionRequest,
  ): Promise<DangerZoneActionResult> {
    const expected = DANGER_ZONE_CONFIRM[actionId];
    if (!confirmationMatches(expected, request.confirmation)) {
      throw new DangerZoneRefusal(
        "confirm",
        `Type ${expected} exactly to confirm. The action was not run.`,
      );
    }
    if (isOverlapActionId(actionId)) return this.endOverlap(actionId);
    if (actionId === "reset-local-json") return this.resetLocalJson(request);
    return this.clearLocal(request);
  }

  private async endOverlap(
    actionId: keyof typeof OVERLAP_PREVIOUS_ENV,
  ): Promise<DangerZoneActionResult> {
    const variableName = OVERLAP_PREVIOUS_ENV[actionId];
    const model = buildDangerZoneModel({
      provider: this.options.provider,
      facts: this.facts(),
      verifiedBackup: null,
      dataDir: this.options.dataDir,
      credentialsEndOverlapHref: dangerZoneCardHref("end-service-overlap"),
    });
    const card = model.cards.find((candidate) => candidate.id === actionId);
    if (card?.enabled !== true) {
      throw new DangerZoneRefusal(
        "disabled",
        card?.disabledReason ?? "This overlap action is disabled.",
      );
    }
    try {
      await removeConvexPreviousEnv(variableName, {
        cwd: this.options.convexCwd,
        run: this.options.runConvexCommand ?? spawnConvexCommand,
      });
    } catch (error: unknown) {
      if (error instanceof DangerZoneRefusal) throw error;
      throw new DangerZoneRefusal(
        "overlap-unchanged",
        `Convex env remove failed for ${variableName}. Overlap was left in place.`,
      );
    }
    try {
      await removeLocalEnvAssignment(this.options.localEnvPath, variableName);
    } catch (error: unknown) {
      delete this.options.env[variableName];
      if (error instanceof DangerZoneRefusal) {
        throw new DangerZoneRefusal(
          error.code,
          `${error.message} ${variableName} was removed from the Convex deployment. Restart local processes.`,
        );
      }
      throw new DangerZoneRefusal(
        "permission",
        `Removed ${variableName} from the Convex deployment, but the local env file could not be updated. Restart local processes.`,
      );
    }
    delete this.options.env[variableName];
    const detail = `Immediately removed ${variableName}. Clients still using the previous token fail closed now. There is no grace period. Restart local processes that loaded the previous environment. Convex owner data was not deleted.`;
    return this.succeed(actionId, detail, [], "off");
  }

  private async resetLocalJson(request: DangerZoneActionRequest): Promise<DangerZoneActionResult> {
    if (request.acceptEmptyLocalCore !== true) {
      throw new DangerZoneRefusal(
        "confirm",
        "Reset local JSON requires the checkbox that you have a recent backup or accept an empty local core.",
      );
    }
    const quarantined = await quarantineNamedFiles({
      dataDir: this.options.dataDir,
      basenames: basenamesFor("reset-local-json"),
      lockTimeoutMs: this.options.lockTimeoutMs ?? 2_000,
      now: () => this.now(),
    });
    const detail =
      quarantined.length === 0
        ? "Local core state is already absent. Convex data was not modified."
        : `Quarantined ${quarantined.length} local core file(s). Convex data was not modified.`;
    return this.succeed("reset-local-json", detail, quarantined, null);
  }

  private async clearLocal(request: DangerZoneActionRequest): Promise<DangerZoneActionResult> {
    if (request.backup === undefined) {
      throw new DangerZoneRefusal(
        "backup",
        "Clear local requires a verified backup from the last 24 hours or an explicit skip.",
      );
    }
    if (request.backup.mode === "skip") {
      if (request.backup.acceptIrreversibleLoss !== true) {
        throw new DangerZoneRefusal(
          "backup",
          "Skipping the backup requires the checkbox that you accept irreversible local loss.",
        );
      }
    } else {
      await assertVerifiedBackup({
        requestedPath: request.backup.path,
        directories: this.options.backupDirectories,
        dataDir: this.options.dataDir,
        now: this.now(),
      });
    }
    const quarantined = await quarantineNamedFiles({
      dataDir: this.options.dataDir,
      basenames: basenamesFor("clear-local"),
      lockTimeoutMs: this.options.lockTimeoutMs ?? 2_000,
      now: () => this.now(),
    });
    const detail = `Quarantined ${quarantined.length} local file(s) with a .corrupt-* rename. Convex data was not modified.`;
    return this.succeed("clear-local", detail, quarantined, null);
  }

  private async succeed(
    actionId: DangerZoneActionId,
    detail: string,
    quarantinedPaths: string[],
    overlap: "off" | null,
  ): Promise<DangerZoneActionResult> {
    const audit: DangerZoneAuditRecord = {
      actionId,
      timestamp: this.now().toISOString(),
      provider: this.options.provider,
      pid: this.options.pid ?? process.pid,
      hostname: this.options.hostname ?? os.hostname(),
      outcome: "success",
      convexDataDeletes: 0,
      quarantinedBasenames: quarantinedPaths.map((filePath) => path.basename(filePath)),
    };
    const line = `danger-zone success action=${audit.actionId} at=${audit.timestamp} provider=${audit.provider} pid=${audit.pid} convexDataDeletes=0`;
    this.options.log?.(line);
    try {
      await appendDangerZoneAudit(path.join(this.options.dataDir, AUDIT_BASENAME), audit);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "audit failed";
      throw new DangerZoneRefusal(
        "permission",
        `${detail} ${message} Quarantined: ${quarantinedPaths.join(", ") || "(none)"}.`,
      );
    }
    return {
      actionId,
      outcome: "success",
      detail,
      convexDataDeletes: 0,
      quarantinedPaths,
      overlap,
      audit,
    };
  }
}

export function createDangerZoneFromEnv(
  provider: DangerZoneProvider = resolvePersistenceProviderName(),
): DangerZoneService {
  return new DangerZoneService({
    dataDir: JARVIS_DATA_DIR,
    provider,
    env: process.env,
    localEnvPath: path.resolve(process.cwd(), ".env.local"),
    backupDirectories: [path.resolve(process.cwd(), "backups")],
    convexCwd: process.cwd(),
    runConvexCommand: spawnConvexCommand,
    log: (line) => console.info(line),
  });
}

/** Test and unconfigured adapters. Refuses Convex env removal instead of spawning a CLI. */
export function createInactiveDangerZone(provider: DangerZoneProvider): DangerZoneService {
  return new DangerZoneService({
    dataDir: path.join(os.tmpdir(), "jarvis-danger-zone-inactive"),
    provider,
    env: {},
    localEnvPath: path.join(os.tmpdir(), "jarvis-danger-zone-inactive.env"),
    backupDirectories: [],
    convexCwd: process.cwd(),
    runConvexCommand: () =>
      Promise.reject(
        new DangerZoneRefusal(
          "overlap-unchanged",
          "Convex env remove is not configured for this process. Overlap was left in place.",
        ),
      ),
  });
}
