/**
 * Typed confirmations shared by Danger zone and any Credentials deep link.
 * Credentials must import these strings and must not define its own.
 */
export const DANGER_ZONE_CONFIRM = {
  "end-service-overlap": "END OVERLAP",
  "end-approval-overlap": "END APPROVAL OVERLAP",
  "end-delivery-overlap": "END DELIVERY OVERLAP",
  "reset-local-json": "RESET JSON",
  "clear-local": "CLEAR LOCAL",
} as const;

export const DANGER_ZONE_ACTION_IDS = [
  "end-service-overlap",
  "end-approval-overlap",
  "end-delivery-overlap",
  "reset-local-json",
  "clear-local",
] as const;

export type DangerZoneActionId = (typeof DANGER_ZONE_ACTION_IDS)[number];

export const OVERLAP_PREVIOUS_ENV = {
  "end-service-overlap": "JARVIS_SERVICE_TOKEN_PREVIOUS",
  "end-approval-overlap": "JARVIS_APPROVAL_TOKEN_PREVIOUS",
  "end-delivery-overlap": "JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS",
} as const;

export type OverlapActionId = keyof typeof OVERLAP_PREVIOUS_ENV;

export function isDangerZoneActionId(value: string): value is DangerZoneActionId {
  return (DANGER_ZONE_ACTION_IDS as readonly string[]).includes(value);
}

export function isOverlapActionId(value: string): value is OverlapActionId {
  return Object.prototype.hasOwnProperty.call(OVERLAP_PREVIOUS_ENV, value);
}

/** Case-sensitive exact match. Paste is allowed. Whitespace is not trimmed. */
export function confirmationMatches(expected: string, typed: string): boolean {
  return typed === expected;
}

export function dangerZonePagePath(): string {
  return "/settings/danger";
}

/** Persistence tab Backup control. Danger does not export an archive itself. */
export const PERSISTENCE_BACKUP_HREF = "/settings/persistence#backup";

/** Canonical Danger zone card. Credentials deep-links here; it does not own a second flow. */
export function dangerZoneCardHref(actionId: DangerZoneActionId): string {
  return `${dangerZonePagePath()}#${actionId}`;
}
