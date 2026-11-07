// Fail-closed freshness evaluation for the special-use table snapshot (design
// R2; #779 obligations 1 & 5). The policy is usable only while its snapshot is
// within a reviewed freshness bound; a stale, future-dated, or unparseable
// snapshot denies all allowlist use. This pure evaluation is used both at load
// and, per the design, pinned at reservation and re-checked before the effect,
// so a reservation that pauses across the bound is refused. No I/O; the clock is
// supplied by the caller (a trusted clock source is an implementation concern).

export type FreshnessReason =
  "fresh" | "stale" | "future-snapshot" | "invalid-snapshot" | "invalid-bound";

export interface FreshnessInput {
  /** ISO-8601 snapshot timestamp of the vendored table. */
  readonly snapshotDate: string;
  /** Current time in epoch milliseconds, from a trusted clock. */
  readonly nowMs: number;
  /** Maximum allowed age in milliseconds (reviewed bound). */
  readonly maxAgeMs: number;
}

export interface FreshnessResult {
  readonly fresh: boolean;
  readonly reason: FreshnessReason;
  /** Age in ms when computable (snapshot valid and not in the future). */
  readonly ageMs?: number;
}

/** Evaluate freshness, failing closed on any malformed or out-of-range input. */
export function evaluateFreshness(input: FreshnessInput): FreshnessResult {
  const { snapshotDate, nowMs, maxAgeMs } = input;

  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return { fresh: false, reason: "invalid-bound" };
  }

  const snapshotMs = Date.parse(snapshotDate);
  if (Number.isNaN(snapshotMs)) {
    return { fresh: false, reason: "invalid-snapshot" };
  }
  if (snapshotMs > nowMs) {
    return { fresh: false, reason: "future-snapshot" };
  }

  const ageMs = nowMs - snapshotMs;
  return ageMs <= maxAgeMs
    ? { fresh: true, reason: "fresh", ageMs }
    : { fresh: false, reason: "stale", ageMs };
}
