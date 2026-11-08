// Durable single-use ledger at the egress boundary for `security:tcp-check`
// (design: single-use consumption / "no reconnect"; #779 obligation 2). This is
// a **pure reducer** over the ledger state; the real store (Convex) applies each
// step as one atomic read-modify-write keyed on the claim key. No I/O.
//
// The one rule that makes single-use real: consumption is a two-phase durable
// record. `beginConsume` atomically reserves the key as `consuming` *before* any
// socket is opened; `finalizeConsume` records the terminal outcome as `settled`.
// A replay therefore has exactly three cases and **never a second connect**:
//   * key absent      → `fresh` (this caller alone may proceed to connect);
//   * key `consuming`  → `replay-consuming` → the effect is **uncertain** (a
//     socket may have been opened and the outcome never recorded — e.g. an
//     enforcer crash between begin and finalize); return `effect_uncertain`;
//   * key `settled`    → `replay-settled` → return the stored terminal outcome.
// Retirement is permanent: a settled key is never reopened, and a consuming key
// resolves only when its true outcome is finalized (or stays uncertain).

/** Terminal outcome of a consumed single-use claim. */
export type SettledOutcome = "completed" | "failed" | "timed-out" | "cancelled";

export type LedgerPhase = "consuming" | "settled";

export interface LedgerEntry {
  readonly claimKey: string;
  readonly phase: LedgerPhase;
  /** Present only when `phase === "settled"`. */
  readonly outcome?: SettledOutcome;
  readonly beganAtMs: number;
  readonly settledAtMs?: number;
}

export interface SingleUseLedger {
  readonly entries: Readonly<Record<string, LedgerEntry>>;
}

const SETTLED_OUTCOMES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "timed-out",
  "cancelled",
]);

export function emptyLedger(): SingleUseLedger {
  return { entries: {} };
}

export function statusOf(ledger: SingleUseLedger, claimKey: string): LedgerEntry | null {
  return Object.prototype.hasOwnProperty.call(ledger.entries, claimKey)
    ? ledger.entries[claimKey]!
    : null;
}

export type BeginResult =
  | { readonly kind: "fresh"; readonly ledger: SingleUseLedger }
  | {
      readonly kind: "replay-consuming";
      readonly entry: LedgerEntry;
      readonly ledger: SingleUseLedger;
    }
  | {
      readonly kind: "replay-settled";
      readonly entry: LedgerEntry;
      readonly ledger: SingleUseLedger;
    }
  | { readonly kind: "invalid-input"; readonly ledger: SingleUseLedger };

export interface BeginInput {
  readonly claimKey: string;
  readonly nowMs: number;
}

/**
 * Atomically reserve the claim key for a single connect, or report the replay
 * case. Only a `fresh` result authorises a connect.
 */
export function beginConsume(ledger: SingleUseLedger, input: BeginInput): BeginResult {
  if (
    typeof input.claimKey !== "string" ||
    input.claimKey.length === 0 ||
    typeof input.nowMs !== "number" ||
    !Number.isFinite(input.nowMs)
  ) {
    return { kind: "invalid-input", ledger };
  }
  const existing = statusOf(ledger, input.claimKey);
  if (existing !== null) {
    return existing.phase === "settled"
      ? { kind: "replay-settled", entry: existing, ledger }
      : { kind: "replay-consuming", entry: existing, ledger };
  }
  const entry: LedgerEntry = {
    claimKey: input.claimKey,
    phase: "consuming",
    beganAtMs: input.nowMs,
  };
  return {
    kind: "fresh",
    ledger: { entries: { ...ledger.entries, [input.claimKey]: entry } },
  };
}

export type FinalizeReason = "ok" | "no-entry" | "already-settled" | "invalid-input";

export interface FinalizeResult {
  readonly ledger: SingleUseLedger;
  readonly reason: FinalizeReason;
}

export interface FinalizeInput {
  readonly claimKey: string;
  readonly outcome: SettledOutcome;
  readonly nowMs: number;
}

/**
 * Record the terminal outcome for a `consuming` key. Idempotent: finalizing an
 * already-settled key is refused and leaves the stored outcome unchanged (so a
 * duplicate finalize can never overwrite a recorded result). A missing key is
 * refused — finalize must follow a begin.
 */
export function finalizeConsume(ledger: SingleUseLedger, input: FinalizeInput): FinalizeResult {
  if (
    typeof input.claimKey !== "string" ||
    input.claimKey.length === 0 ||
    !SETTLED_OUTCOMES.has(input.outcome) ||
    typeof input.nowMs !== "number" ||
    !Number.isFinite(input.nowMs)
  ) {
    return { ledger, reason: "invalid-input" };
  }
  const existing = statusOf(ledger, input.claimKey);
  if (existing === null) {
    return { ledger, reason: "no-entry" };
  }
  if (existing.phase === "settled") {
    return { ledger, reason: "already-settled" };
  }
  const settled: LedgerEntry = {
    ...existing,
    phase: "settled",
    outcome: input.outcome,
    settledAtMs: input.nowMs,
  };
  return {
    ledger: { entries: { ...ledger.entries, [input.claimKey]: settled } },
    reason: "ok",
  };
}
