import type { GoogleHomePinDescription } from "./googleHomeAnnouncementProvider.js";

/**
 * Operator evidence for the Local V1 Google Home kit.
 *
 * `commissioningClaimed` is fixed false. A receipt, a green drill, or a
 * discovered speaker is not commissioning. Commissioning is an owner decision
 * on the physical host after this package is reviewed.
 */
export type GoogleHomeKitEvidence = {
  readonly kit: "local-v1-google-home";
  readonly commissioningClaimed: false;
  readonly physicalHostRequired: true;
  readonly generatedAt: string;
  readonly pins: GoogleHomePinDescription;
  readonly discovery: {
    readonly status: "unavailable" | "found";
    readonly deviceCount: number;
    readonly names: readonly string[];
  };
  readonly tts: {
    readonly status: "audible" | "failed";
    readonly detail: string;
  };
  readonly failClosedDrills: {
    readonly status: "passed" | "failed" | "not-run";
    readonly detail: string;
  };
  readonly governedAnnouncement: {
    readonly status: "not-executed" | "observed";
    readonly reason: string;
    readonly receipt: {
      readonly receiptId: string;
      readonly tool: string;
      readonly operation: string;
      readonly status: string;
      readonly errorCode?: string;
    } | null;
  };
};

export const GOOGLE_HOME_KIT_ENDPOINTS = {
  stage: "POST /api/v1/projects/{projectId}/tool-actions",
  approve:
    "npm run owner:approve -- --project <projectId> --action <actionId> --expect-file <expected.json>",
  execute: "POST /api/v1/projects/{projectId}/tool-actions/{actionId}/execute",
  tool: "home",
  operation: "announce",
} as const;

/** Existing transport tests that force no-device, timeout, and cancellation. */
export const GOOGLE_HOME_FAIL_CLOSED_TESTS = [
  "tests/localCastCleanup.test.ts",
  "tests/localCastAcquisition.test.ts",
  "tests/localCastAcceptedConnection.test.ts",
  "tests/localCastLifecycle.test.ts",
  "tests/homeAnnouncementTool.test.ts",
  "tests/googleHomeCommissioningKit.test.ts",
] as const;

export function publicCastDiscovery(
  devices: readonly { readonly name: string }[],
): GoogleHomeKitEvidence["discovery"] {
  const names = devices.map((device) => device.name);
  if (names.length === 0) return { status: "unavailable", deviceCount: 0, names: [] };
  return { status: "found", deviceCount: names.length, names };
}

export function assembleGoogleHomeKitEvidence(input: {
  generatedAt: string;
  pins: GoogleHomePinDescription;
  discovery: GoogleHomeKitEvidence["discovery"];
  tts: GoogleHomeKitEvidence["tts"];
  failClosedDrills: GoogleHomeKitEvidence["failClosedDrills"];
  governedAnnouncement: GoogleHomeKitEvidence["governedAnnouncement"];
}): GoogleHomeKitEvidence {
  return {
    kit: "local-v1-google-home",
    commissioningClaimed: false,
    physicalHostRequired: true,
    generatedAt: input.generatedAt,
    pins: input.pins,
    discovery: input.discovery,
    tts: input.tts,
    failClosedDrills: input.failClosedDrills,
    governedAnnouncement: input.governedAnnouncement,
  };
}

/**
 * The kit never executes a ToolAction. API URL, service token, project id and
 * action id are ignored, including an approved `home:announce` id. Playback
 * uses the existing execute route from a separate operator command.
 */
function notExecutedReason(configured: boolean): string {
  const ignored = configured
    ? " A configured API URL, service token, project id or action id does not send a request."
    : "";
  return (
    "The kit does not execute ToolActions." +
    ignored +
    " After owner approval, a separate operator command uses the existing" +
    " POST /api/v1/projects/{projectId}/tool-actions/{actionId}/execute route."
  );
}

export function kitGovernedAnnouncement(
  env: NodeJS.ProcessEnv = {},
): GoogleHomeKitEvidence["governedAnnouncement"] {
  const configured = [
    env.JARVIS_API_BASE_URL,
    env.JARVIS_SERVICE_TOKEN,
    env.JARVIS_HOME_ANNOUNCE_PROJECT_ID,
    env.JARVIS_HOME_ANNOUNCE_ACTION_ID,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
  return {
    status: "not-executed",
    reason: notExecutedReason(configured),
    receipt: null,
  };
}

/** Copy only the receipt fields an operator needs. Tokens and arguments stay out. */
export function publicAnnouncementReceipt(
  value: unknown,
): GoogleHomeKitEvidence["governedAnnouncement"]["receipt"] {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.receiptId !== "string" || typeof record.status !== "string") return null;
  if (record.tool !== "home" || record.operation !== "announce") return null;
  return {
    receiptId: record.receiptId,
    tool: "home",
    operation: "announce",
    status: record.status,
    ...(typeof record.errorCode === "string" ? { errorCode: record.errorCode } : {}),
  };
}
