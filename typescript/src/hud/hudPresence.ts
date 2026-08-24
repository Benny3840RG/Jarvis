import type { SystemStatus } from "../http/contracts.js";

export const HUD_PRESENCES = [
  "connecting",
  "idle",
  "waiting_for_approval",
  "reconciling",
  "blocked",
  "degraded",
  "error",
  "offline",
] as const;

export type HudPresence = (typeof HUD_PRESENCES)[number];

export function isHudPresence(value: unknown): value is HudPresence {
  return typeof value === "string" && (HUD_PRESENCES as readonly string[]).includes(value);
}

/**
 * Presentation-only mapping from authoritative runtime state.
 * This is not a second status authority.
 *
 * listening / processing / executing / waiting_for_tool are real operator
 * states, but they are not fields on SystemStatus today. Do not invent them
 * here. When the runtime emits an explicit presence field, extend HUD_PRESENCES
 * and prefer that field over this derivation.
 */
export function deriveHudPresence(input: {
  status?: SystemStatus | null;
  proposedApprovalCount?: number;
}): HudPresence {
  const status = input.status;
  if (!status) return "connecting";
  if (status.status === "unavailable") return "offline";
  if (status.zState === "suspended") return "blocked";
  if (
    status.reconciliation.state === "degraded" ||
    status.reconciliation.lastCycleOutcome === "failed"
  ) {
    return "reconciling";
  }
  if (status.status === "degraded") return "degraded";
  if ((input.proposedApprovalCount ?? 0) > 0) return "waiting_for_approval";
  const layers = Object.values(status.layers);
  if (layers.some((layer) => layer.status === "blocked")) return "blocked";
  if (layers.some((layer) => layer.status !== "ready")) return "degraded";
  return "idle";
}
