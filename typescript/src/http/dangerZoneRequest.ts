import { isDangerZoneActionId, type DangerZoneActionId } from "../settings/dangerZone/confirm.js";
import type { DangerZoneActionRequest } from "../settings/dangerZone/service.js";
import { DangerZoneRefusal } from "../settings/dangerZone/errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDangerZoneActionId(value: string): DangerZoneActionId {
  if (!isDangerZoneActionId(value)) {
    throw new DangerZoneRefusal("disabled", "Unknown Danger zone action.");
  }
  return value;
}

export function parseDangerZoneActionRequest(body: unknown): DangerZoneActionRequest {
  if (!isRecord(body)) {
    throw new DangerZoneRefusal("confirm", "Danger zone action body must be a JSON object.");
  }
  const allowed = new Set(["confirmation", "acceptEmptyLocalCore", "backup"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new DangerZoneRefusal(
        "confirm",
        "Danger zone action body contains an unexpected field.",
      );
    }
  }
  if (typeof body.confirmation !== "string") {
    throw new DangerZoneRefusal("confirm", "confirmation must be a string.");
  }
  const request: DangerZoneActionRequest = { confirmation: body.confirmation };
  if (body.acceptEmptyLocalCore !== undefined) {
    if (typeof body.acceptEmptyLocalCore !== "boolean") {
      throw new DangerZoneRefusal("confirm", "acceptEmptyLocalCore must be a boolean.");
    }
    request.acceptEmptyLocalCore = body.acceptEmptyLocalCore;
  }
  if (body.backup !== undefined) {
    if (!isRecord(body.backup)) {
      throw new DangerZoneRefusal("backup", "backup must be an object.");
    }
    const backupKeys = new Set(Object.keys(body.backup));
    if (body.backup.mode === "skip") {
      if (backupKeys.size !== 2 || !backupKeys.has("acceptIrreversibleLoss")) {
        throw new DangerZoneRefusal(
          "backup",
          "Skip backup must only set mode and acceptIrreversibleLoss.",
        );
      }
      if (typeof body.backup.acceptIrreversibleLoss !== "boolean") {
        throw new DangerZoneRefusal("backup", "acceptIrreversibleLoss must be a boolean.");
      }
      request.backup = {
        mode: "skip",
        acceptIrreversibleLoss: body.backup.acceptIrreversibleLoss,
      };
    } else if (body.backup.mode === "verified") {
      if (backupKeys.size !== 2 || !backupKeys.has("path")) {
        throw new DangerZoneRefusal("backup", "Verified backup must only set mode and path.");
      }
      if (
        typeof body.backup.path !== "string" ||
        body.backup.path.length === 0 ||
        body.backup.path.length > 4096
      ) {
        throw new DangerZoneRefusal("backup", "Verified backup path is missing.");
      }
      request.backup = { mode: "verified", path: body.backup.path };
    } else {
      throw new DangerZoneRefusal("backup", "backup.mode must be verified or skip.");
    }
  }
  return request;
}
