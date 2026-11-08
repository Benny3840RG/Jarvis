// Admission state machine for the Stage 3 `security:tcp-check` capability
// (design: docs/design/issue-732-stage3-authorised-diagnostics.md; #779
// obligations 3 & 4 at the storage layer). This module is a **pure, I/O-free
// reducer**: every transition is a deterministic function of the prior state
// plus its input, returning the next state and a typed outcome. It performs no
// network, no clock read (the caller supplies `nowMs` from a trusted clock),
// and no persistence. The real durable store (Convex) applies each transition
// inside a single atomic read-modify-write and CASes on `fenceCounter`; keeping
// the logic pure here is what makes the R1 invariants unit-testable.
//
// Invariants enforced (design R1, round 5–8):
//   * **At-most-one-active-check per owner** — a single owner-wide slot. While
//     it is occupied (reserved / started / uncertain) no second attempt is
//     admitted. The count bound holds structurally, independent of timing.
//   * **Never-refunded started history** — a `started` record is retained for a
//     rolling rate window and is *not* removed when the check completes, so a
//     fast-finishing check cannot reclaim rate budget.
//   * **Fenced `reserved → started`** — the transition requires the live fence
//     token. Recovery and completion bump the fence, so any resumed straggler
//     presenting a superseded token is rejected (the storage half of the
//     effect-boundary fence; the egress-boundary half is Phase 3).
//   * **Recovery by durable phase** — a stale `reserved` (no durable `started`,
//     so no connect was ever gated) is released by fenced cleanup; a stale
//     `started` is held as `uncertain` and the slot is **never reclaimed by
//     time** (obligation 4) — only the enforcer's quiescence signal resolves it.
//   * **`uncertain → resolved` under named recovery assumptions** — resolution
//     is driven only by an enforcer `socket-closed` / `never-admitted` signal,
//     never inferred from elapsed time. With no signal the slot stays held and
//     the status is `blocked`.

/** Durable phase of the single owner-wide admission slot. */
export type AdmissionPhase = "reserved" | "started" | "uncertain";

/** A never-refunded record that a connect attempt reached the `started` phase. */
export interface StartedRecord {
  readonly attemptId: string;
  readonly startedAtMs: number;
}

/** The attempt currently holding the owner-wide slot. */
export interface ActiveAttempt {
  readonly attemptId: string;
  /** Live fence token; superseded by any recovery/completion bump. */
  readonly fenceToken: number;
  readonly phase: AdmissionPhase;
  /** Policy epoch pinned at reservation; the enforcer compares it at connect. */
  readonly policyEpoch: number;
  readonly reservedAtMs: number;
  /** Set when the attempt advances to `started`. */
  readonly startedAtMs?: number;
}

/** Full admission state for one owner. Serializable; the caller persists it. */
export interface AdmissionState {
  /** The single owner-wide slot; `null` when free (at-most-one-active-check). */
  readonly active: ActiveAttempt | null;
  /** Monotonic fence counter; every reservation/supersession draws the next. */
  readonly fenceCounter: number;
  /** Never-refunded `started` records, retained for the rate window. */
  readonly startedHistory: readonly StartedRecord[];
}

/** Rate-limit configuration for the never-refunded started window. */
export interface RateConfig {
  /** Rolling window length in ms (reviewed bound). */
  readonly rateWindowMs: number;
  /** Maximum `started` records permitted within the window. */
  readonly maxStartsPerWindow: number;
}

/** 60-second rolling window for the started-history rate limit (design R1). */
export const RATE_WINDOW_MS = 60_000;

/** Default cap: 10 starts per window, so the 11th sequential attempt is denied. */
export const DEFAULT_MAX_STARTS_PER_WINDOW = 10;

export const DEFAULT_RATE_CONFIG: RateConfig = {
  rateWindowMs: RATE_WINDOW_MS,
  maxStartsPerWindow: DEFAULT_MAX_STARTS_PER_WINDOW,
};

/** The result of a transition: the next state plus a typed outcome. */
export interface Transition<Outcome> {
  readonly state: AdmissionState;
  readonly outcome: Outcome;
}

/** A fresh, empty admission state for a new owner. */
export function emptyAdmissionState(): AdmissionState {
  return { active: null, fenceCounter: 0, startedHistory: [] };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidConfig(config: RateConfig): boolean {
  return (
    isFiniteNumber(config.rateWindowMs) &&
    config.rateWindowMs > 0 &&
    isFiniteNumber(config.maxStartsPerWindow) &&
    Number.isInteger(config.maxStartsPerWindow) &&
    config.maxStartsPerWindow >= 0
  );
}

/** Drop started records strictly older than the window; keep the rest in order. */
function pruneHistory(
  history: readonly StartedRecord[],
  nowMs: number,
  windowMs: number,
): readonly StartedRecord[] {
  const cutoff = nowMs - windowMs;
  const kept = history.filter((record) => record.startedAtMs > cutoff);
  return kept.length === history.length ? history : kept;
}

/** Count started records whose age is within the window (fail-closed on future). */
export function startsInWindow(state: AdmissionState, nowMs: number, windowMs: number): number {
  const cutoff = nowMs - windowMs;
  let count = 0;
  for (const record of state.startedHistory) {
    if (record.startedAtMs > cutoff) count += 1;
  }
  return count;
}

/** True when no attempt holds the owner-wide slot. */
export function isSlotFree(state: AdmissionState): boolean {
  return state.active === null;
}

// --- reserve -------------------------------------------------------------

export type ReserveReason = "slot-busy" | "rate-limited" | "invalid-input";

export type ReserveOutcome =
  | { readonly ok: true; readonly fenceToken: number }
  | { readonly ok: false; readonly reason: ReserveReason };

export interface ReserveInput {
  readonly attemptId: string;
  readonly nowMs: number;
  readonly policyEpoch: number;
  readonly config?: RateConfig;
}

/**
 * Atomically take the owner-wide slot. Fails closed if the slot is already held
 * (at-most-one-active-check) or the never-refunded started window is full.
 */
export function reserve(state: AdmissionState, input: ReserveInput): Transition<ReserveOutcome> {
  const config = input.config ?? DEFAULT_RATE_CONFIG;
  if (
    !isNonEmptyString(input.attemptId) ||
    !isFiniteNumber(input.nowMs) ||
    !isFiniteNumber(input.policyEpoch) ||
    !Number.isInteger(input.policyEpoch) ||
    !isValidConfig(config)
  ) {
    return { state, outcome: { ok: false, reason: "invalid-input" } };
  }

  if (state.active !== null) {
    return { state, outcome: { ok: false, reason: "slot-busy" } };
  }

  const prunedHistory = pruneHistory(state.startedHistory, input.nowMs, config.rateWindowMs);
  const inWindow = prunedHistory.length;
  if (inWindow >= config.maxStartsPerWindow) {
    return {
      state: { ...state, startedHistory: prunedHistory },
      outcome: { ok: false, reason: "rate-limited" },
    };
  }

  const fenceToken = state.fenceCounter + 1;
  const active: ActiveAttempt = {
    attemptId: input.attemptId,
    fenceToken,
    phase: "reserved",
    policyEpoch: input.policyEpoch,
    reservedAtMs: input.nowMs,
  };
  return {
    state: { active, fenceCounter: fenceToken, startedHistory: prunedHistory },
    outcome: { ok: true, fenceToken },
  };
}

// --- start ---------------------------------------------------------------

export type StartReason = "no-reservation" | "fence-mismatch" | "wrong-phase" | "invalid-input";

export type StartOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: StartReason };

export interface StartInput {
  readonly attemptId: string;
  readonly fenceToken: number;
  readonly nowMs: number;
}

/**
 * Fenced `reserved → started`: records the durable `started` write and appends a
 * never-refunded history entry. Requires the live fence token, so a superseded
 * attempt cannot start. This durable write is the point past which a connect may
 * be gated, so recovery treats pre-`started` and post-`started` attempts apart.
 */
export function start(state: AdmissionState, input: StartInput): Transition<StartOutcome> {
  if (
    !isNonEmptyString(input.attemptId) ||
    !isFiniteNumber(input.fenceToken) ||
    !isFiniteNumber(input.nowMs)
  ) {
    return { state, outcome: { ok: false, reason: "invalid-input" } };
  }
  const active = state.active;
  if (active === null || active.attemptId !== input.attemptId) {
    return { state, outcome: { ok: false, reason: "no-reservation" } };
  }
  if (active.fenceToken !== input.fenceToken) {
    return { state, outcome: { ok: false, reason: "fence-mismatch" } };
  }
  if (active.phase !== "reserved") {
    return { state, outcome: { ok: false, reason: "wrong-phase" } };
  }

  const started: ActiveAttempt = { ...active, phase: "started", startedAtMs: input.nowMs };
  const startedHistory = [
    ...state.startedHistory,
    { attemptId: input.attemptId, startedAtMs: input.nowMs },
  ];
  return { state: { ...state, active: started, startedHistory }, outcome: { ok: true } };
}

// --- complete ------------------------------------------------------------

export type CompleteReason = "no-attempt" | "fence-mismatch" | "wrong-phase" | "invalid-input";

export type CompleteOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: CompleteReason };

export interface CompleteInput {
  readonly attemptId: string;
  readonly fenceToken: number;
}

/**
 * Fence-conditional terminal commit for a `started` attempt: releases the slot
 * and bumps the fence so a resumed straggler's late write is rejected. The
 * never-refunded history entry is retained. A recovery that moved the attempt to
 * `uncertain` has already superseded the fence, so a straggler's `complete` with
 * the old token is refused here.
 */
export function complete(state: AdmissionState, input: CompleteInput): Transition<CompleteOutcome> {
  if (!isNonEmptyString(input.attemptId) || !isFiniteNumber(input.fenceToken)) {
    return { state, outcome: { ok: false, reason: "invalid-input" } };
  }
  const active = state.active;
  if (active === null || active.attemptId !== input.attemptId) {
    return { state, outcome: { ok: false, reason: "no-attempt" } };
  }
  if (active.fenceToken !== input.fenceToken) {
    return { state, outcome: { ok: false, reason: "fence-mismatch" } };
  }
  if (active.phase !== "started") {
    return { state, outcome: { ok: false, reason: "wrong-phase" } };
  }

  return {
    state: { ...state, active: null, fenceCounter: state.fenceCounter + 1 },
    outcome: { ok: true },
  };
}

// --- recover -------------------------------------------------------------

export type RecoverOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "released-stale-reservation" }
  | { readonly kind: "held-uncertain" }
  | { readonly kind: "already-uncertain" };

/**
 * Recovery keyed off the durable phase (design R1/R6):
 *   * slot free → nothing to do;
 *   * stale `reserved` → no connect was ever gated behind a durable `started`,
 *     so release the slot by fenced cleanup (bump the fence to supersede);
 *   * stale `started` → an effect may be in flight; move to `uncertain`, hold
 *     the slot, and bump the fence so any resumed straggler is superseded. The
 *     slot is **not** reclaimed by time — only an enforcer signal resolves it;
 *   * already `uncertain` → idempotent, hold.
 */
export function recover(state: AdmissionState): Transition<RecoverOutcome> {
  const active = state.active;
  if (active === null) {
    return { state, outcome: { kind: "idle" } };
  }
  if (active.phase === "reserved") {
    return {
      state: { ...state, active: null, fenceCounter: state.fenceCounter + 1 },
      outcome: { kind: "released-stale-reservation" },
    };
  }
  if (active.phase === "started") {
    const fenceToken = state.fenceCounter + 1;
    return {
      state: {
        ...state,
        active: { ...active, phase: "uncertain", fenceToken },
        fenceCounter: fenceToken,
      },
      outcome: { kind: "held-uncertain" },
    };
  }
  return { state, outcome: { kind: "already-uncertain" } };
}

// --- resolve -------------------------------------------------------------

export type ResolveSignal = "socket-closed" | "never-admitted";

export type ResolveReason =
  "not-uncertain" | "attempt-mismatch" | "invalid-signal" | "invalid-input";

export type ResolveOutcome =
  | { readonly ok: true; readonly signal: ResolveSignal }
  | { readonly ok: false; readonly reason: ResolveReason };

export interface ResolveInput {
  readonly attemptId: string;
  readonly signal: ResolveSignal;
}

const RESOLVE_SIGNALS: ReadonlySet<string> = new Set(["socket-closed", "never-admitted"]);

/**
 * `uncertain → resolved`, driven only by the enforcer's quiescence evidence
 * (`socket-closed` or `never-admitted`). Releases the slot and bumps the fence.
 * There is deliberately no time-based path: with no signal the caller does not
 * call `resolve`, the slot stays held, and {@link admissionStatus} reports
 * `blocked` (obligation 4 — eventual resolution under named recovery
 * assumptions, never inferred from elapsed time).
 */
export function resolve(state: AdmissionState, input: ResolveInput): Transition<ResolveOutcome> {
  if (!isNonEmptyString(input.attemptId)) {
    return { state, outcome: { ok: false, reason: "invalid-input" } };
  }
  if (!RESOLVE_SIGNALS.has(input.signal)) {
    return { state, outcome: { ok: false, reason: "invalid-signal" } };
  }
  const active = state.active;
  if (active === null || active.phase !== "uncertain") {
    return { state, outcome: { ok: false, reason: "not-uncertain" } };
  }
  if (active.attemptId !== input.attemptId) {
    return { state, outcome: { ok: false, reason: "attempt-mismatch" } };
  }
  return {
    state: { ...state, active: null, fenceCounter: state.fenceCounter + 1 },
    outcome: { ok: true, signal: input.signal },
  };
}

// --- status --------------------------------------------------------------

export type AdmissionStatus = "free" | "reserved" | "active" | "blocked";

/**
 * Observable status of the owner's slot. `uncertain` surfaces as `blocked`: the
 * slot is held pending enforcer evidence and no new check is admissible.
 */
export function admissionStatus(state: AdmissionState): AdmissionStatus {
  const active = state.active;
  if (active === null) return "free";
  switch (active.phase) {
    case "reserved":
      return "reserved";
    case "started":
      return "active";
    case "uncertain":
      return "blocked";
  }
}
