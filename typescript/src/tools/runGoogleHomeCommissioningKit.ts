/**
 * Local V1 Google Home operator kit.
 *
 * Discovers Cast devices, checks the pinned-target map, synthesizes one
 * audible clip, runs the existing fail-closed Cast drills, and optionally
 * executes an already-approved `home:announce` ToolAction. It never approves,
 * never pins a device by itself, and never claims commissioning.
 *
 *   npm run home:kit
 *   npm run home:kit -- --out /tmp/jarvis-google-home-kit.json
 *
 * An already-approved announcement is executed only when all of these are set,
 * and only against a loopback API:
 *   JARVIS_API_BASE_URL
 *   JARVIS_SERVICE_TOKEN
 *   JARVIS_HOME_ANNOUNCE_PROJECT_ID
 *   JARVIS_HOME_ANNOUNCE_ACTION_ID
 */

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isLoopbackHost } from "../http/config.js";
import {
  GOOGLE_HOME_FAIL_CLOSED_TESTS,
  assembleGoogleHomeKitEvidence,
  publicAnnouncementReceipt,
  publicCastDiscovery,
  type GoogleHomeKitEvidence,
} from "../integrations/googleHome/commissioningKit.js";
import { describeGoogleHomePins } from "../integrations/googleHome/googleHomeAnnouncementProvider.js";
import {
  discoverLocalCastDevices,
  synthesizeAnnouncement,
} from "../integrations/googleHome/localCastTransport.js";
import { assessWav } from "../integrations/googleHome/wavAudibility.js";
import { writePrivateJsonFile } from "../persistence/atomicJsonFile.js";

const typescriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function evidencePath(argv: readonly string[]): string {
  const index = argv.indexOf("--out");
  const requested = index >= 0 ? argv[index + 1] : undefined;
  if (requested !== undefined && requested.trim().length > 0) return path.resolve(requested);
  return path.join(tmpdir(), "jarvis-google-home-kit-evidence.json");
}

async function audibleTts(): Promise<GoogleHomeKitEvidence["tts"]> {
  try {
    const audio = await synthesizeAnnouncement(
      "Jarvis home check.",
      process.env.JARVIS_GOOGLE_HOME_TTS_VOICE?.trim() || "en-au",
      AbortSignal.timeout(15_000),
    );
    const assessment = assessWav(audio);
    if (assessment.status !== "audible") {
      return { status: "failed", detail: `local-tts-${assessment.status}` };
    }
    return { status: "audible", detail: "local-tts-audible" };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "local-tts-failed";
    return { status: "failed", detail: message };
  }
}

function failClosedDrills(): GoogleHomeKitEvidence["failClosedDrills"] {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...GOOGLE_HOME_FAIL_CLOSED_TESTS],
    { cwd: typescriptRoot, encoding: "utf8", timeout: 120_000 },
  );
  if (result.error) {
    return { status: "failed", detail: result.error.message };
  }
  const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-500);
  if (result.status === 0) return { status: "passed", detail: tail || "fail-closed drills passed" };
  return { status: "failed", detail: tail || `exit ${result.status ?? "null"}` };
}

async function governedAnnouncement(): Promise<GoogleHomeKitEvidence["governedAnnouncement"]> {
  const base = process.env.JARVIS_API_BASE_URL?.trim();
  const token = process.env.JARVIS_SERVICE_TOKEN?.trim();
  const projectId = process.env.JARVIS_HOME_ANNOUNCE_PROJECT_ID?.trim();
  const actionId = process.env.JARVIS_HOME_ANNOUNCE_ACTION_ID?.trim();
  if (!base || !token || !projectId || !actionId) {
    return {
      status: "not-executed",
      reason:
        "No approved home:announce action was supplied. The kit does not approve and does not emit audio. On the host, stage the action, approve it with npm run owner:approve, then rerun with JARVIS_API_BASE_URL, JARVIS_SERVICE_TOKEN, JARVIS_HOME_ANNOUNCE_PROJECT_ID and JARVIS_HOME_ANNOUNCE_ACTION_ID.",
      receipt: null,
    };
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return {
      status: "not-executed",
      reason: "JARVIS_API_BASE_URL is not a URL. No announcement was sent.",
      receipt: null,
    };
  }
  if (!isLoopbackHost(url.hostname)) {
    return {
      status: "not-executed",
      reason: "Refused: announcement execution is limited to a loopback Jarvis API.",
      receipt: null,
    };
  }
  const endpoint = new URL(
    `/api/v1/projects/${encodeURIComponent(projectId)}/tool-actions/${encodeURIComponent(actionId)}/execute`,
    url,
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ idempotencyKey: `home-kit-${actionId}` }),
    signal: AbortSignal.timeout(35_000),
  });
  const body: unknown = await response.json().catch(() => null);
  const receipt = publicAnnouncementReceipt(body);
  if (!response.ok || receipt === null) {
    const problem =
      typeof body === "object" && body !== null && "type" in body && typeof body.type === "string"
        ? body.type
        : "unreadable-response";
    return {
      status: "observed",
      reason: `Execute returned HTTP ${response.status} (${problem}). This is not commissioning.`,
      receipt,
    };
  }
  return {
    status: "observed",
    reason: `Observed ToolAction receipt status ${receipt.status}. This is not commissioning.`,
    receipt,
  };
}

async function main(): Promise<void> {
  const timeoutMs = Number.parseInt(
    process.env.JARVIS_GOOGLE_HOME_DISCOVERY_TIMEOUT_MS ?? "2000",
    10,
  );
  const devices = await discoverLocalCastDevices(Number.isFinite(timeoutMs) ? timeoutMs : 2000);
  const evidence = assembleGoogleHomeKitEvidence({
    generatedAt: new Date().toISOString(),
    pins: describeGoogleHomePins(process.env),
    discovery: publicCastDiscovery(devices),
    tts: await audibleTts(),
    failClosedDrills: failClosedDrills(),
    governedAnnouncement: await governedAnnouncement(),
  });
  const destination = evidencePath(process.argv.slice(2));
  await writePrivateJsonFile(destination, evidence);
  process.stdout.write(`${destination}\n`);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (evidence.tts.status !== "audible" || evidence.failClosedDrills.status !== "passed") {
    process.exitCode = 1;
  }
}

await main();
