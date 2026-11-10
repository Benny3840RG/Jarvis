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

// Supported snapshot grammar: a date `YYYY-MM-DD` or a UTC timestamp
// `YYYY-MM-DDTHH:MM:SS(.fff)?Z`. `Date.parse` is deliberately NOT used — it
// normalises invalid calendar dates (e.g. 2026-02-30 → 2026-03-02) and accepts
// many lax forms, so a malformed date could be reported fresh. This parser
// validates the exact grammar and round-trips every field through the resulting
// UTC Date, rejecting any value whose components do not survive the round trip.
const SNAPSHOT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z)?$/;

/** Strictly parse a supported snapshot string to epoch ms, or null if invalid. */
export function parseSnapshotMs(snapshotDate: string): number | null {
  if (typeof snapshotDate !== "string") return null;
  const match = SNAPSHOT_PATTERN.exec(snapshotDate);
  if (match === null) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "0"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const ms = Number(frac.padEnd(3, "0"));
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const date = new Date(epoch);
  // Round-trip: reject any field the UTC calendar normalised (e.g. Feb 30,
  // month 13, a non-leap Feb 29, hour 24).
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return epoch;
}

/** Evaluate freshness, failing closed on any malformed or out-of-range input. */
export function evaluateFreshness(input: FreshnessInput): FreshnessResult {
  const { snapshotDate, nowMs, maxAgeMs } = input;

  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return { fresh: false, reason: "invalid-bound" };
  }

  const snapshotMs = parseSnapshotMs(snapshotDate);
  if (snapshotMs === null) {
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
