import { z } from "zod";

import { ARCHIVE_GROUPS } from "../backup/archiveManifest.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import type { PersistenceProviderName } from "../persistence/providerSelection.js";

/**
 * Settings → Persistence is a control surface over `npm run backup`.
 * JARVIS-006: this view is not a second provider or recovery authority.
 * Provider selection stays in `.env.local`. Resume is never implied.
 */

export const V4_PRESENT_GROUPS = ["core", "memory", "businessRecords"] as const;

export const V4_ABSENT_GROUPS = ["notesAndEvidence", "orchestration", "quoteAggregate"] as const;

export const V4_CONVEX_EXPORT_REFUSAL =
  'Archive v4 captures JSON-backed groups only, but PERSISTENCE_PROVIDER selects "convex". Refusing; archive v1-v3 is unaffected.';

export const V4_CONVEX_EXPORT_COPY =
  "Provider must be JSON. Active provider is Convex — export refused. Switch to JSON only if you intend a JSON-sourced archive.";

export const PROVIDER_MISCONFIGURED_BANNER =
  "Provider misconfigured. Jarvis will not start durable commands until this is fixed.";

export const NO_SILENT_FALLBACK =
  "Provider selection is explicit. Jarvis will not silently fall back from Convex to JSON.";

export const ARCHIVE_SECRET_WARNING =
  "Archives must not contain service, approval, or delivery tokens. Jarvis does not write those secrets into the backup file.";

export const PROVIDER_HELPER = "Change PERSISTENCE_PROVIDER in `.env.local`, then restart.";

export const OWNERSHIP_DOCS_PATH = "typescript/docs/architecture/ownership-and-concurrency.md";

export const ARCHIVE_V4_DOCS_PATH = "typescript/docs/operators/archive-v4.md";

export const CLASSIC_INCLUDED =
  "assistant state, tasks, reminders, builds, logs, upgrades, assets, preferences (per current classic archive version)";

export const CLASSIC_GAPS =
  "Denser business domains (clients, quotes, invoices, projects, properties, enquiries, errands) are not in the classic archive. Those need archive v4, which is still partial.";

const FALLBACK_CTA = /try json instead|fall back to json|fallback to json|use json instead/i;

export const PERSISTENCE_ACTIONS = [
  "export-classic",
  "verify-classic",
  "restore-classic",
  "export-v4",
  "verify-v4",
  "restore-v4",
  "resume-v4",
  "inspect-v4-destination",
] as const;

export type PersistenceActionName = (typeof PERSISTENCE_ACTIONS)[number];

export const PERSISTENCE_COMMANDS = [
  { action: "Export classic", command: "npm run backup -- export <file>", exposedInSettings: true },
  { action: "Verify classic", command: "npm run backup -- verify <file>", exposedInSettings: true },
  {
    action: "Restore classic",
    command: "npm run backup -- restore <file> --confirm-empty-target",
    exposedInSettings: true,
  },
  { action: "Export v4", command: "npm run backup -- export-v4 <file>", exposedInSettings: true },
  { action: "Verify v4", command: "npm run backup -- verify-v4 <file>", exposedInSettings: true },
  {
    action: "Restore v4",
    command: "npm run backup -- restore-v4 <file> <dir> --allow-partial",
    exposedInSettings: true,
  },
  {
    action: "Resume v4",
    command: "npm run backup -- restore-v4 <file> <dir> --allow-partial --resume",
    exposedInSettings: true,
  },
  {
    action: "Restore drill (dev)",
    command: "npm run restore-drill",
    exposedInSettings: false,
  },
] as const;

export type HealthState = "ok" | "degraded" | "fail-closed";

export type PersistenceHealth = {
  state: HealthState;
  status: string;
  checkedAt: string;
  detail: string | null;
};

export type PersistenceSettingsView = {
  title: "Persistence";
  honesty: typeof NO_SILENT_FALLBACK;
  fallbackCta: null;
  providerSwitch: null;
  provider: {
    active: PersistenceProviderName | null;
    misconfigured: boolean;
    banner: string | null;
    convexDeployment: string | null;
    jsonStatePath: string;
    jsonStoresNote: string;
    configSource: ".env.local";
    helper: typeof PROVIDER_HELPER;
    ownershipDocsPath: typeof OWNERSHIP_DOCS_PATH;
    archiveV4DocsPath: typeof ARCHIVE_V4_DOCS_PATH;
    radiosDisabled: true;
  };
  health: PersistenceHealth;
  backup: {
    classicLabel: "Classic";
    classicSummary: string;
    classicIncluded: typeof CLASSIC_INCLUDED;
    classicGaps: typeof CLASSIC_GAPS;
    v4Label: "Partial / JSON-only";
    v4Summary: string;
    v4Completeness: "partial";
    v4Present: string[];
    v4Absent: string[];
    v4ExportEnabled: boolean;
    v4ExportRefusal: string | null;
    exportWarning: typeof ARCHIVE_SECRET_WARNING;
    commands: Array<{ action: string; command: string; exposedInSettings: boolean }>;
    restoreDrillExposed: false;
  };
  actions: {
    exportClassic: boolean;
    verifyClassic: boolean;
    restoreClassic: boolean;
    exportV4: boolean;
    verifyV4: boolean;
    restoreV4: boolean;
    resumeV4: boolean;
  };
  suggestedClassicPath: string;
  suggestedV4Path: string;
};

export type ClassicCounts = {
  tasks: number;
  reminders: number;
  builds: number;
  buildLogs: number;
  upgrades: number;
  assets: number;
  preferences: number;
};

export type V4Outcome = {
  completeness: "partial" | "complete";
  present: string[];
  absent: string[];
  unresolvedReferenceCount: number;
  verifiedGroups: string[];
  headline: string;
};

export type DestinationInspection = {
  kind: string;
  resumeAvailable: boolean;
  detail: string;
};

export type PersistenceActionInput = {
  action: PersistenceActionName;
  file?: string;
  destination?: string;
  confirmEmptyTarget?: boolean;
  understandIdsRecreated?: boolean;
  allowPartial?: boolean;
  acknowledgePartial?: boolean;
  resume?: boolean;
  typedConfirmation?: string;
};

export type PersistenceActionResult = {
  status: "completed" | "refused" | "failed";
  action: PersistenceActionName;
  code: string | null;
  detail: string;
  path: string | null;
  counts: ClassicCounts | null;
  v4: V4Outcome | null;
  destination: DestinationInspection | null;
  verifyRecommended: boolean;
};

export function redactPersistenceText(message: string, secrets: Array<string | undefined>): string {
  return secrets
    .filter((secret): secret is string => Boolean(secret))
    .reduce((text, secret) => text.split(secret).join("[REDACTED]"), message);
}

export function presentFailureDetail(message: string, secrets: Array<string | undefined>): string {
  const redacted = redactPersistenceText(message, secrets);
  if (FALLBACK_CTA.test(redacted)) {
    return "The configured persistence provider could not be reached or validated. Jarvis will not silently fall back to another provider.";
  }
  return redacted;
}

export function backupStamp(now: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${part(now.getUTCMonth() + 1)}${part(now.getUTCDate())}` +
    `-${part(now.getUTCHours())}${part(now.getUTCMinutes())}${part(now.getUTCSeconds())}`
  );
}

export function suggestedClassicBackupPath(now: Date): string {
  return `backups/jarvis-${backupStamp(now)}.json`;
}

export function suggestedV4BackupPath(now: Date): string {
  return `backups/jarvis-v4-${backupStamp(now)}.json`;
}

export type ProviderReconciliation =
  { kind: "active"; provider: PersistenceProviderName } | { kind: "misconfigured"; detail: string };

/** Active provider is the env selection. A running process never silently replaces it. */
export function reconcileProvider(
  configured: string | undefined,
  running: PersistenceProviderName,
): ProviderReconciliation {
  let selected: PersistenceProviderName;
  try {
    selected = resolvePersistenceProviderName(configured);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "misconfigured",
      detail: `${PROVIDER_MISCONFIGURED_BANNER} ${detail}`,
    };
  }
  if (selected !== running) {
    return {
      kind: "misconfigured",
      detail: `${PROVIDER_MISCONFIGURED_BANNER} PERSISTENCE_PROVIDER selects "${selected}" but this process is running "${running}". Jarvis will not switch providers.`,
    };
  }
  return { kind: "active", provider: selected };
}

export function capturedGroupsMatchContract(): boolean {
  const absent = ARCHIVE_GROUPS.filter(
    (group) => !(V4_PRESENT_GROUPS as readonly string[]).includes(group),
  );
  return (
    absent.length === V4_ABSENT_GROUPS.length &&
    absent.every((group, index) => group === V4_ABSENT_GROUPS[index])
  );
}

type CoverageSource = {
  completeness: "partial" | "complete";
  coverage: { present: readonly string[]; absent: readonly string[] };
  unresolvedReferences: readonly unknown[];
  verification: { groups: readonly { group: string }[] } | null;
};

/** Partial coverage stays visible. Absent groups cannot be labelled a complete backup. */
export function honestV4Outcome(source: CoverageSource): V4Outcome {
  const present = [...source.coverage.present];
  const absent = [...source.coverage.absent];
  const partial = source.completeness !== "complete" || absent.length > 0;
  const verifiedGroups = (source.verification?.groups ?? []).map((entry) => entry.group);
  return {
    completeness: partial ? "partial" : "complete",
    present,
    absent,
    unresolvedReferenceCount: source.unresolvedReferences.length,
    verifiedGroups,
    headline: partial
      ? `completeness: partial. Present: ${present.join(", ") || "none"}. Absent: ${absent.join(", ") || "none"}. This is not a complete backup.`
      : "completeness: complete. Absent: none.",
  };
}

export function classifyBackupFailure(message: string): string {
  if (/not empty/i.test(message)) return "target-not-empty";
  if (/already holds a completed restore/i.test(message)) return "destination-completed";
  if (/interrupted restore of a different archive/i.test(message))
    return "destination-interrupted-other";
  if (/interrupted restore of this archive/i.test(message)) return "destination-interrupted-same";
  if (/not written by a restore/i.test(message)) return "destination-not-restore";
  if (/symbolic link/i.test(message)) return "destination-symlink";
  if (/overlaps the live Jarvis data directory/i.test(message)) return "destination-overlaps-live";
  if (/--allow-partial/i.test(message)) return "allow-partial-required";
  if (/selects "convex"/i.test(message)) return "v4-export-refused";
  return "backup-failed";
}

export function explainBackupFailure(message: string): string {
  if (/not empty/i.test(message)) {
    return `${message} Export first or use an empty target. Jarvis will not merge.`;
  }
  return message;
}

export type ActionGate = { ok: true } | { ok: false; code: string; detail: string };

function requireFile(input: PersistenceActionInput): ActionGate | string {
  const file = input.file?.trim();
  if (!file) {
    return { ok: false, code: "missing-path", detail: "Choose a backup file path." };
  }
  return file;
}

function requireDestination(input: PersistenceActionInput): ActionGate | string {
  const destination = input.destination?.trim();
  if (!destination) {
    return {
      ok: false,
      code: "missing-destination",
      detail: "Choose an empty destination directory.",
    };
  }
  return destination;
}

export function gatePersistenceAction(
  view: PersistenceSettingsView,
  input: PersistenceActionInput,
): ActionGate {
  const blocked = view.provider.misconfigured || view.health.state === "fail-closed";
  const file = requireFile(input);

  if (input.action === "export-classic") {
    if (typeof file !== "string") return file;
    if (blocked) {
      return {
        ok: false,
        code: "provider-unavailable",
        detail:
          "Classic export needs the configured provider. Jarvis will not silently fall back to another provider.",
      };
    }
    return { ok: true };
  }

  if (input.action === "verify-classic" || input.action === "verify-v4") {
    if (typeof file !== "string") return file;
    return { ok: true };
  }

  if (input.action === "restore-classic") {
    if (typeof file !== "string") return file;
    if (
      input.confirmEmptyTarget !== true ||
      input.understandIdsRecreated !== true ||
      input.typedConfirmation !== "restore"
    ) {
      return {
        ok: false,
        code: "empty-target-required",
        detail:
          "Restore classic is empty-target only and requires --confirm-empty-target. Confirm that IDs and timestamps are recreated, and type restore. Jarvis will not merge.",
      };
    }
    if (blocked) {
      return {
        ok: false,
        code: "provider-unavailable",
        detail:
          "Classic restore needs the configured provider. Jarvis will not silently fall back to another provider.",
      };
    }
    return { ok: true };
  }

  if (input.action === "export-v4") {
    if (typeof file !== "string") return file;
    if (view.provider.active === "convex") {
      return {
        ok: false,
        code: "v4-export-refused",
        detail: `${V4_CONVEX_EXPORT_COPY} ${V4_CONVEX_EXPORT_REFUSAL}`,
      };
    }
    if (view.provider.active !== "json" || blocked) {
      return {
        ok: false,
        code: "provider-unavailable",
        detail:
          "Archive v4 export needs the JSON provider files. Jarvis will not silently fall back to another provider.",
      };
    }
    return { ok: true };
  }

  if (input.action === "inspect-v4-destination") {
    if (typeof file !== "string") return file;
    const destination = requireDestination(input);
    if (typeof destination !== "string") return destination;
    return { ok: true };
  }

  if (input.action === "restore-v4" || input.action === "resume-v4") {
    if (typeof file !== "string") return file;
    const destination = requireDestination(input);
    if (typeof destination !== "string") return destination;
    if (input.allowPartial !== true || input.acknowledgePartial !== true) {
      return {
        ok: false,
        code: "allow-partial-required",
        detail:
          "This archive is partial. restore-v4 requires --allow-partial and an acknowledgement that this is a staged development restore, not full recovery.",
      };
    }
    if (input.typedConfirmation !== "restore-v4") {
      return {
        ok: false,
        code: "confirmation-required",
        detail: "Type restore-v4 to confirm this staged restore.",
      };
    }
    if (input.action === "restore-v4" && input.resume === true) {
      return {
        ok: false,
        code: "resume-not-default",
        detail:
          "Resume is explicit and is never the default. A plain retry does not resume. Use resume-v4 with --resume.",
      };
    }
    if (input.action === "resume-v4" && input.resume !== true) {
      return {
        ok: false,
        code: "resume-required",
        detail: "Resume only runs when --resume is set on the explicit resume action.",
      };
    }
    return { ok: true };
  }

  return { ok: false, code: "invalid-action", detail: "Unknown persistence action." };
}

export function buildPersistenceSettingsView(input: {
  reconciliation: ProviderReconciliation;
  health: PersistenceHealth;
  convexDeployment: string | null;
  jsonStatePath: string;
  now: Date;
}): PersistenceSettingsView {
  const reconciliation = input.reconciliation;
  const active = reconciliation.kind === "active" ? reconciliation.provider : null;
  const misconfigured = reconciliation.kind === "misconfigured";
  const banner = reconciliation.kind === "misconfigured" ? reconciliation.detail : null;
  const convexBlocksV4 = active !== "json";
  const providerDown = misconfigured || input.health.state === "fail-closed";
  return {
    title: "Persistence",
    honesty: NO_SILENT_FALLBACK,
    fallbackCta: null,
    providerSwitch: null,
    provider: {
      active,
      misconfigured,
      banner,
      convexDeployment: active === "convex" ? input.convexDeployment : null,
      jsonStatePath: input.jsonStatePath,
      jsonStoresNote:
        "Archive v4 also reads the memory and business JSON stores beside this file. Classic backup does not include those business domains.",
      configSource: ".env.local",
      helper: PROVIDER_HELPER,
      ownershipDocsPath: OWNERSHIP_DOCS_PATH,
      archiveV4DocsPath: ARCHIVE_V4_DOCS_PATH,
      radiosDisabled: true,
    },
    health: input.health,
    backup: {
      classicLabel: "Classic",
      classicSummary:
        "Provider-neutral archive for core assistant data (npm run backup -- export|verify|restore).",
      classicIncluded: CLASSIC_INCLUDED,
      classicGaps: CLASSIC_GAPS,
      v4Label: "Partial / JSON-only",
      v4Summary:
        "JSON-only. Broader groups; today always completeness: partial. export-v4 | verify-v4 | restore-v4.",
      v4Completeness: "partial",
      v4Present: [...V4_PRESENT_GROUPS],
      v4Absent: [...V4_ABSENT_GROUPS],
      v4ExportEnabled: active === "json" && !providerDown,
      v4ExportRefusal: convexBlocksV4
        ? `${V4_CONVEX_EXPORT_COPY} ${V4_CONVEX_EXPORT_REFUSAL}`
        : null,
      exportWarning: ARCHIVE_SECRET_WARNING,
      commands: PERSISTENCE_COMMANDS.map((entry) => ({ ...entry })),
      restoreDrillExposed: false,
    },
    actions: {
      exportClassic: active !== null && !providerDown,
      verifyClassic: true,
      restoreClassic: active !== null && !providerDown,
      exportV4: active === "json" && !providerDown,
      verifyV4: true,
      restoreV4: true,
      resumeV4: true,
    },
    suggestedClassicPath: suggestedClassicBackupPath(input.now),
    suggestedV4Path: suggestedV4BackupPath(input.now),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parsePersistenceAction(
  value: unknown,
): { ok: true; action: PersistenceActionInput } | { ok: false; detail: string } {
  if (!isRecord(value)) return { ok: false, detail: "Persistence action must be an object." };
  const action = value.action;
  if (typeof action !== "string" || !(PERSISTENCE_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, detail: "Unknown persistence action." };
  }
  const file = optionalString(value.file);
  const destination = optionalString(value.destination);
  if (file !== undefined && file.trim().length > 1024) {
    return { ok: false, detail: "Backup file path is too long." };
  }
  if (destination !== undefined && destination.trim().length > 1024) {
    return { ok: false, detail: "Destination path is too long." };
  }
  return {
    ok: true,
    action: {
      action: action as PersistenceActionName,
      ...(file === undefined ? {} : { file }),
      ...(destination === undefined ? {} : { destination }),
      ...(optionalBoolean(value.confirmEmptyTarget) === undefined
        ? {}
        : { confirmEmptyTarget: value.confirmEmptyTarget as boolean }),
      ...(optionalBoolean(value.understandIdsRecreated) === undefined
        ? {}
        : { understandIdsRecreated: value.understandIdsRecreated as boolean }),
      ...(optionalBoolean(value.allowPartial) === undefined
        ? {}
        : { allowPartial: value.allowPartial as boolean }),
      ...(optionalBoolean(value.acknowledgePartial) === undefined
        ? {}
        : { acknowledgePartial: value.acknowledgePartial as boolean }),
      ...(optionalBoolean(value.resume) === undefined ? {} : { resume: value.resume as boolean }),
      ...(optionalString(value.typedConfirmation) === undefined
        ? {}
        : { typedConfirmation: value.typedConfirmation as string }),
    },
  };
}

const commandSchema = z.object({
  action: z.string(),
  command: z.string(),
  exposedInSettings: z.boolean(),
});

const countsSchema = z.object({
  tasks: z.number(),
  reminders: z.number(),
  builds: z.number(),
  buildLogs: z.number(),
  upgrades: z.number(),
  assets: z.number(),
  preferences: z.number(),
});

const v4Schema = z.object({
  completeness: z.enum(["partial", "complete"]),
  present: z.array(z.string()),
  absent: z.array(z.string()),
  unresolvedReferenceCount: z.number(),
  verifiedGroups: z.array(z.string()),
  headline: z.string(),
});

export const persistenceSettingsViewSchema = z.object({
  title: z.literal("Persistence"),
  honesty: z.string(),
  fallbackCta: z.null(),
  providerSwitch: z.null(),
  provider: z.object({
    active: z.enum(["json", "convex"]).nullable(),
    misconfigured: z.boolean(),
    banner: z.string().nullable(),
    convexDeployment: z.string().nullable(),
    jsonStatePath: z.string(),
    jsonStoresNote: z.string(),
    configSource: z.literal(".env.local"),
    helper: z.string(),
    ownershipDocsPath: z.string(),
    archiveV4DocsPath: z.string(),
    radiosDisabled: z.literal(true),
  }),
  health: z.object({
    state: z.enum(["ok", "degraded", "fail-closed"]),
    status: z.string(),
    checkedAt: z.string(),
    detail: z.string().nullable(),
  }),
  backup: z.object({
    classicLabel: z.string(),
    classicSummary: z.string(),
    classicIncluded: z.string(),
    classicGaps: z.string(),
    v4Label: z.literal("Partial / JSON-only"),
    v4Summary: z.string(),
    v4Completeness: z.literal("partial"),
    v4Present: z.array(z.string()),
    v4Absent: z.array(z.string()),
    v4ExportEnabled: z.boolean(),
    v4ExportRefusal: z.string().nullable(),
    exportWarning: z.string(),
    commands: z.array(commandSchema),
    restoreDrillExposed: z.literal(false),
  }),
  actions: z.object({
    exportClassic: z.boolean(),
    verifyClassic: z.boolean(),
    restoreClassic: z.boolean(),
    exportV4: z.boolean(),
    verifyV4: z.boolean(),
    restoreV4: z.boolean(),
    resumeV4: z.boolean(),
  }),
  suggestedClassicPath: z.string(),
  suggestedV4Path: z.string(),
});

export const persistenceActionResultSchema = z.object({
  status: z.enum(["completed", "refused", "failed"]),
  action: z.enum(PERSISTENCE_ACTIONS),
  code: z.string().nullable(),
  detail: z.string(),
  path: z.string().nullable(),
  counts: countsSchema.nullable(),
  v4: v4Schema.nullable(),
  destination: z
    .object({
      kind: z.string(),
      resumeAvailable: z.boolean(),
      detail: z.string(),
    })
    .nullable(),
  verifyRecommended: z.boolean(),
});

export const persistenceSettingsOutputShape = {
  settings: persistenceSettingsViewSchema,
};

export const persistenceActionOutputShape = {
  result: persistenceActionResultSchema,
};
