export const DANGER_ZONE_REFUSAL_CODES = [
  "confirm",
  "disabled",
  "backup",
  "path",
  "permission",
  "lock",
  "overlap-unchanged",
  "in-flight",
] as const;

export type DangerZoneRefusalCode = (typeof DANGER_ZONE_REFUSAL_CODES)[number];

/** A named, operator-safe refusal. Messages must not contain token values. */
export class DangerZoneRefusal extends Error {
  readonly code: DangerZoneRefusalCode;

  constructor(code: DangerZoneRefusalCode, message: string) {
    super(message);
    this.name = "DangerZoneRefusal";
    this.code = code;
  }
}

export function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
