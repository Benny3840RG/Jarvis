import path from "node:path";

import { businessDataFiles, coreDataFiles } from "../../persistence/jarvisDataPaths.js";
import {
  DANGER_ZONE_CONFIRM,
  OVERLAP_PREVIOUS_ENV,
  type DangerZoneActionId,
  type OverlapActionId,
} from "./confirm.js";

/** Core document the JSON runtime quarantines on its own. Not the memory or business set. */
export const RESET_JSON_BASENAMES = ["jarvis-state.json"] as const;

export const CLEAR_LOCAL_BASENAMES = [
  ...Object.values(coreDataFiles).map((filePath) => path.basename(filePath)),
  ...Object.values(businessDataFiles).map((filePath) => path.basename(filePath)),
] as const;

export const AUDIT_BASENAME = "jarvis-operator-audit.jsonl";

export const VERIFY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type DangerZoneProvider = "json" | "convex";

export type VerifyState = "not-run" | "passed" | "failed";

export type PublicOverlap = "on" | "off" | "not-configured";

export type DangerZoneCard = {
  id: DangerZoneActionId;
  title: string;
  enabled: boolean;
  disabledReason: string | null;
  warning: string | null;
  blastRadius: string[];
  confirm: string;
  cli: string;
  prerequisites: string[];
  willQuarantine: string[];
  willNotTouch: string[];
  overlap: PublicOverlap | null;
  fingerprint: string | null;
};

export type VerifiedBackup = {
  path: string;
  verifiedAt: string;
};

export type DangerZoneExclusion = {
  id: string;
  reason: string;
};

export type DangerZoneModel = {
  title: "Danger zone";
  lede: string;
  provider: DangerZoneProvider;
  verifiedBackup: VerifiedBackup | null;
  cards: DangerZoneCard[];
  excluded: DangerZoneExclusion[];
  credentialsEndOverlapHref: string;
};

export const PHASE_A_EXCLUSIONS: readonly DangerZoneExclusion[] = [
  {
    id: "wipe-convex-owner",
    reason:
      "Convex owner wipe needs a dedicated empty-target design. It is not a Settings control.",
  },
  {
    id: "restore-non-empty",
    reason: "Restore into a non-empty provider belongs to Persistence and is refused by design.",
  },
  {
    id: "enable-remote-gateway",
    reason: "Remote gateway exposure is a Credentials checklist, not a wipe.",
  },
  {
    id: "constitutional-change",
    reason: "Constitutional and ΩΣ changes are not Settings toggles.",
  },
  {
    id: "restore-drill",
    reason: "restore-drill is dev-only and stays in the docs.",
  },
];

const SAFER_PRELUDE =
  "Safer prelude: npm run backup -- export <file> then npm run backup -- verify <file>.";

export type CredentialFacts = {
  serviceOverlap: "on" | "off";
  serviceFingerprint: string | null;
  approvalOverlap: "on" | "off";
  approvalFingerprint: string | null;
  deliveryConfigured: boolean;
  deliveryOverlap: "on" | "off";
  deliveryFingerprint: string | null;
  lastVerify: VerifyState;
};

function overlapWarning(lastVerify: VerifyState): string | null {
  if (lastVerify === "passed") return null;
  return "Clients on the old token will break immediately. New-token verification has not passed. Ending overlap does not wait.";
}

function overlapCard(
  id: OverlapActionId,
  title: string,
  blastRadius: string[],
  facts: CredentialFacts,
  overlap: PublicOverlap,
  fingerprint: string | null,
  disabledReason: string | null,
): DangerZoneCard {
  const enabled = disabledReason === null;
  return {
    id,
    title,
    enabled,
    disabledReason,
    warning: enabled ? overlapWarning(facts.lastVerify) : null,
    blastRadius,
    confirm: DANGER_ZONE_CONFIRM[id],
    cli: `npx convex env remove ${OVERLAP_PREVIOUS_ENV[id]}`,
    prerequisites: [
      "New token verified (npm run smoke:convex or status) is recommended.",
      "Restart every local process on the new env before ending overlap.",
    ],
    willQuarantine: [],
    willNotTouch: [
      "Convex owner records",
      "Local JSON state files",
      "Backup files already on disk",
    ],
    overlap,
    fingerprint,
  };
}

function serviceDisabled(facts: CredentialFacts): string | null {
  return facts.serviceOverlap === "on" ? null : "No previous token accepted.";
}

function approvalDisabled(facts: CredentialFacts): string | null {
  return facts.approvalOverlap === "on" ? null : "No previous token accepted.";
}

function deliveryDisabled(facts: CredentialFacts): string | null {
  if (!facts.deliveryConfigured) return "Delivery token is not configured.";
  if (facts.deliveryOverlap !== "on") return "No previous token accepted.";
  return null;
}

export function buildDangerZoneModel(input: {
  provider: DangerZoneProvider;
  facts: CredentialFacts;
  verifiedBackup: VerifiedBackup | null;
  dataDir: string;
  credentialsEndOverlapHref: string;
}): DangerZoneModel {
  const { facts, provider, dataDir } = input;
  const resetPaths = RESET_JSON_BASENAMES.map((basename) => path.join(dataDir, basename));
  const clearPaths = CLEAR_LOCAL_BASENAMES.map((basename) => path.join(dataDir, basename));
  const convexLocalNote =
    provider === "convex"
      ? "The live provider is Convex. This only affects local JSON files used as fallback or recovery stores, not live Convex data."
      : "The live provider is JSON. This quarantines the local core file and leaves Convex untouched.";

  const clearConvexNote =
    provider === "convex"
      ? "The live provider is Convex. Convex is untouched. This only affects local JSON on this machine."
      : "The live provider is JSON. Convex is untouched. Remote recovery is not this action.";

  return {
    title: "Danger zone",
    lede: "These actions can interrupt Jarvis or destroy local state. Export a backup from Persistence first when you can.",
    provider,
    verifiedBackup: input.verifiedBackup,
    credentialsEndOverlapHref: input.credentialsEndOverlapHref,
    excluded: [...PHASE_A_EXCLUSIONS],
    cards: [
      overlapCard(
        "end-service-overlap",
        "End service-token overlap",
        [
          `Immediately revokes ${OVERLAP_PREVIOUS_ENV["end-service-overlap"]}. Clients still using the previous service token fail closed at once. There is no grace period.`,
          "Local processes keep the environment they started with until they are restarted.",
          "Convex owner data is not deleted.",
        ],
        facts,
        facts.serviceOverlap,
        facts.serviceFingerprint,
        serviceDisabled(facts),
      ),
      overlapCard(
        "end-approval-overlap",
        "End approval-token overlap",
        [
          `Immediately revokes ${OVERLAP_PREVIOUS_ENV["end-approval-overlap"]}. Approval clients still using the previous token fail closed at once. There is no grace period.`,
          "Does not revoke the service token or the delivery token.",
          "Convex owner data is not deleted.",
        ],
        facts,
        facts.approvalOverlap,
        facts.approvalFingerprint,
        approvalDisabled(facts),
      ),
      overlapCard(
        "end-delivery-overlap",
        "End delivery-token overlap",
        [
          `Immediately revokes ${OVERLAP_PREVIOUS_ENV["end-delivery-overlap"]}. Delivery clients still using the previous token fail closed at once. There is no grace period.`,
          "Does not revoke the service token or the approval token.",
          "Convex owner data is not deleted.",
        ],
        facts,
        facts.deliveryConfigured ? facts.deliveryOverlap : "not-configured",
        facts.deliveryConfigured ? facts.deliveryFingerprint : null,
        deliveryDisabled(facts),
      ),
      {
        id: "reset-local-json",
        title: "Reset local JSON state",
        enabled: true,
        disabledReason: null,
        warning: null,
        blastRadius: [
          "Immediately quarantines jarvis-state.json with a .corrupt-* rename. Jarvis can start with an empty local core. Convex data is NOT modified.",
          convexLocalNote,
        ],
        confirm: DANGER_ZONE_CONFIRM["reset-local-json"],
        cli: "Quarantine typescript/data/jarvis-state.json with the runtime .corrupt-* rename. Do not call Convex delete APIs.",
        prerequisites: [SAFER_PRELUDE],
        willQuarantine: resetPaths,
        willNotTouch: [
          "Convex deployment data",
          "Backup files already on disk",
          "Memory and business JSON files (use Clear local for those)",
        ],
        overlap: null,
        fingerprint: null,
      },
      {
        id: "clear-local",
        title: "Clear local operator data",
        enabled: true,
        disabledReason: null,
        warning: null,
        blastRadius: [
          "Immediately quarantines local JSON on this machine: core, memory (builds, logs, upgrades, assets, preferences), and local business files when present. Files are renamed aside with a .corrupt-* suffix. They are not unlinked. Convex is untouched.",
          clearConvexNote,
        ],
        confirm: DANGER_ZONE_CONFIRM["clear-local"],
        cli: "Quarantine the local data JSON set (core, memory, business) with .corrupt-* renames. Never a Convex owner wipe.",
        prerequisites: [
          "Strongly recommended: Persistence → verify a backup first.",
          SAFER_PRELUDE,
        ],
        willQuarantine: clearPaths,
        willNotTouch: [
          "Convex deployment data",
          "Backup files already on disk",
          "Files outside the Jarvis data directory",
        ],
        overlap: null,
        fingerprint: null,
      },
    ],
  };
}

export function basenamesFor(actionId: DangerZoneActionId): readonly string[] {
  if (actionId === "reset-local-json") return RESET_JSON_BASENAMES;
  if (actionId === "clear-local") return CLEAR_LOCAL_BASENAMES;
  return [];
}
