// Governed external provider for `security:tcp-check` (design: Architecture /
// "the adapter … emits through the supervised egress mediator"; #779 Phase 4).
// This adapter is the only code that drives the effect. Changes from the review:
//
//   * Admission transitions go through a transactional, per-owner store
//     (`AdmissionStore.transition`) so concurrent prepares cannot both win or
//     lose a history write (Codex #1).
//   * The deterministic pre-effect gate runs BEFORE reservation, and the durable
//     `started` write (which charges the never-refunded rate budget) happens only
//     after the pre-connect gate passes — a rejected attempt consumes no budget
//     (Codex #9).
//   * The receipt is derived from the immutable claim (target + approved digest),
//     never from a post-effect policy read or a separate input (Codex #8).
//   * The owner-wide slot is released only on genuine closure; an uncertain
//     effect holds it (Codex #3).
//
// Commissioning posture: the default connector is {@link notCommissionedConnector},
// which fails closed. `createTcpCheckProviderFromEnv` returns `null`, so this
// provider is never spliced into the live tool-execution service.

import { randomUUID } from "node:crypto";

import {
  complete,
  emptyAdmissionState,
  markUncertain,
  releaseReservation,
  reserve,
  resolve,
  start,
  type AdmissionState,
  type RateConfig,
  type ResolveSignal,
  type Transition,
} from "./admission.js";
import { parseCanonicalAddress } from "./address.js";
import { isAllowlisted } from "./allowlist.js";
import { computeAllowlistDigest } from "./allowlistDigest.js";
import { computeClaimBinding, computeClaimKey, type EgressClaim } from "./egressClaim.js";
import {
  BrokerEnforcer,
  type AdmissionSignal,
  type Connector,
  type EnforcerOutcome,
  type FenceChecker,
  type LedgerPort,
} from "./enforcer.js";
import { evaluatePolicyGate } from "./gate.js";
import { evaluateFreshness } from "./freshness.js";
import type { PolicyView } from "./policy.js";
import type { SettledOutcome } from "./singleUseLedger.js";
import {
  isSpecialUse,
  SPECIAL_USE_TABLE_SNAPSHOT_DATE,
  verifySpecialUseTable,
} from "./specialUseTable.js";

export const TCP_CHECK_PROVIDER_NAME = "security-tcp-check-egress-mediator-v1";

/** Connect deadline in ms (design Approved parameters: 5 s). */
export const DEFAULT_CONNECT_DEADLINE_MS = 5000;
/** Capability lease in ms, strictly longer than the deadline (design: 15 s). */
export const DEFAULT_CAPABILITY_LEASE_MS = 15_000;

/** Raised when admission or a pre-effect gate refuses before any socket. */
export class TcpCheckRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TcpCheckRefused";
  }
}

/** Raised by the default connector: the capability is not commissioned. */
export class TcpCheckNotCommissionedError extends Error {
  constructor() {
    super(
      "security:tcp-check is not commissioned: no egress connector or kernel/proxy gate is configured, and no allowlist is populated. Commissioning requires separate owner approval.",
    );
    this.name = "TcpCheckNotCommissionedError";
  }
}

/** The fail-closed default: never opens a socket. */
export const notCommissionedConnector: Connector = {
  async connect(): Promise<never> {
    throw new TcpCheckNotCommissionedError();
  },
};

/**
 * Durable per-owner admission store. `transition` applies a pure reducer to the
 * owner's state inside a single atomic critical section and returns its outcome,
 * so interleaved callers cannot lose an update (Codex #1). The production
 * implementation is a Convex mutation with a compare-and-set; the in-memory
 * reference below uses a per-owner async mutex.
 */
export interface AdmissionStore {
  transition<O>(owner: string, reducer: (state: AdmissionState) => Transition<O>): Promise<O>;
}

/** In-memory reference store with a per-owner mutex (serialises transitions). */
export function createInMemoryAdmissionStore(): AdmissionStore & {
  snapshot(owner: string): AdmissionState;
} {
  const states = new Map<string, AdmissionState>();
  const tails = new Map<string, Promise<unknown>>();

  return {
    snapshot(owner: string): AdmissionState {
      return states.get(owner) ?? emptyAdmissionState();
    },
    async transition<O>(
      owner: string,
      reducer: (state: AdmissionState) => Transition<O>,
    ): Promise<O> {
      const previous = tails.get(owner) ?? Promise.resolve();
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(
        owner,
        previous.then(() => barrier),
      );
      await previous;
      try {
        const state = states.get(owner) ?? emptyAdmissionState();
        const { state: next, outcome } = reducer(state);
        states.set(owner, next);
        return outcome;
      } finally {
        release();
      }
    },
  };
}

/**
 * A durable record authenticating one prepared attempt. `binding` is the trusted
 * hash over the claim's authoritative fields; `retired` marks a reached terminal
 * (a tombstone), with `storedOutcome` set when the effect actually completed so a
 * legitimate completed replay returns the recorded result rather than being
 * treated as a fabricated request (Codex round 4 residual #2).
 */
export interface ClaimBindingRecord {
  readonly binding: string;
  readonly retired: boolean;
  readonly storedOutcome?: SettledOutcome;
}

/**
 * Durable store for claim bindings, written atomically with the reservation. A
 * recreated provider backed by the same store (and the same ledger) can
 * authenticate a persisted attempt and replay its recorded outcome; a fresh
 * store fails closed. The production implementation is a Convex table; the
 * in-memory reference below is the test default.
 */
export interface ClaimBindingStore {
  get(attemptId: string): Promise<ClaimBindingRecord | null> | ClaimBindingRecord | null;
  put(attemptId: string, record: ClaimBindingRecord): Promise<void> | void;
  remove(attemptId: string): Promise<void> | void;
}

export function createInMemoryClaimBindingStore(): ClaimBindingStore {
  const records = new Map<string, ClaimBindingRecord>();
  return {
    get: (attemptId) => records.get(attemptId) ?? null,
    put: (attemptId, record) => {
      records.set(attemptId, record);
    },
    remove: (attemptId) => {
      records.delete(attemptId);
    },
  };
}

export interface TcpCheckProviderDeps {
  /** The compiled active policy, read fresh at prepare and at connect. */
  readonly policy: () => PolicyView;
  readonly admission: AdmissionStore;
  readonly fence: FenceChecker;
  readonly ledger: LedgerPort;
  /** The socket port; defaults to {@link notCommissionedConnector}. */
  readonly connector?: Connector;
  readonly clock: () => number;
  readonly rateConfig?: RateConfig;
  readonly deadlineMs?: number;
  readonly leaseMs?: number;
  /** Durable authenticator for prepared attempts; defaults to an in-memory store. */
  readonly bindingStore?: ClaimBindingStore;
}

export interface TcpCheckInput {
  readonly ip: string;
  readonly port: number;
}

/** The identity the governed boundary supplies for the attempt. */
export interface TcpCheckIdentity {
  /** The authenticated owner — the owner-wide admission/rate bucket key. */
  readonly owner: string;
  readonly project: string;
  /** exact_action_fingerprint: binds the approval to exactly this action. */
  readonly actionFingerprint: string;
  /**
   * The `allowlistDigest` captured when this action was staged/approved, NOT
   * recomputed at prepare. Supplying it from the approval record is what lets a
   * policy change *between approval and prepare* be detected (Codex #4).
   */
  readonly approvedAllowlistDigest: string;
  readonly correlationId: string;
}

export interface TcpCheckPreparedAttempt {
  readonly claim: EgressClaim;
  readonly attemptId: string;
  readonly owner: string;
  readonly providerRequestId: string;
  readonly providerCorrelationId: string;
}

/** Digest-only, redacted result summary. No pasted/resolved values. */
export interface TcpCheckReceiptSummary {
  readonly status: EnforcerOutcome;
  /** The already-authorised target, derived from the immutable claim. */
  readonly target: string;
  /** The approved policy digest pinned in the claim (not a post-effect read). */
  readonly allowlistDigest: string;
  readonly admissionSignal: AdmissionSignal;
  /** Present on a replayed duplicate: the originally recorded outcome. */
  readonly storedOutcome?: SettledOutcome;
}

export interface TcpCheckProvider {
  readonly name: string;
  prepare(input: TcpCheckInput, identity: TcpCheckIdentity): Promise<TcpCheckPreparedAttempt>;
  /** Release an authentic, still-reserved attempt before any effect starts. */
  releasePrepared(attempt: TcpCheckPreparedAttempt): Promise<boolean>;
  sendPrepared(
    attempt: TcpCheckPreparedAttempt,
    signal?: AbortSignal,
  ): Promise<TcpCheckReceiptSummary>;
  /**
   * Apply the enforcer's durable closure signal (`socket-closed` /
   * `never-admitted`) to an attempt previously left `uncertain`, releasing its
   * own slot. Returns whether the attempt was resolved. Never infers closure
   * from elapsed time (Codex #4).
   */
  resolveUncertain(owner: string, attemptId: string, signal: ResolveSignal): Promise<boolean>;
}

/** Deterministic pre-effect target gate (anchor, canonical, special-use, allowlist, freshness). */
function targetAdmissible(policy: PolicyView, input: TcpCheckInput, nowMs: number): boolean {
  try {
    verifySpecialUseTable();
  } catch {
    return false;
  }
  const address = parseCanonicalAddress(input.ip);
  if (address === null || isSpecialUse(address)) return false;
  if (!isAllowlisted(policy.allowlist, input.ip, input.port)) return false;
  // Freshness uses the anchor-verified table snapshot date, identical to the
  // authoritative gate (Codex round 4 #3).
  return evaluateFreshness({
    snapshotDate: SPECIAL_USE_TABLE_SNAPSHOT_DATE,
    nowMs,
    maxAgeMs: policy.maxAgeMs,
  }).fresh;
}

/** Deep-freeze a prepared claim so its fields cannot be mutated in place. */
function freezeClaim(claim: EgressClaim): EgressClaim {
  return Object.freeze({ ...claim, target: Object.freeze({ ...claim.target }) });
}

export function createTcpCheckProvider(deps: TcpCheckProviderDeps): TcpCheckProvider {
  const connector = deps.connector ?? notCommissionedConnector;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_CONNECT_DEADLINE_MS;
  const leaseMs = deps.leaseMs ?? DEFAULT_CAPABILITY_LEASE_MS;
  const bindings = deps.bindingStore ?? createInMemoryClaimBindingStore();

  // The SettledOutcome a completed effect records for replay, or undefined when
  // nothing crossed the egress boundary (a gate/fence rejection or an abort with
  // no socket). `replayed` carries the original stored outcome through.
  const settledOutcomeOf = (result: {
    outcome: EnforcerOutcome;
    storedOutcome?: SettledOutcome;
  }): SettledOutcome | undefined => {
    switch (result.outcome) {
      case "connected":
      case "refused":
      case "timed-out":
      case "error":
      case "cancelled":
        return result.outcome;
      case "replayed":
        return result.storedOutcome;
      default:
        return undefined;
    }
  };

  return {
    name: TCP_CHECK_PROVIDER_NAME,

    async prepare(input, identity): Promise<TcpCheckPreparedAttempt> {
      const policy = deps.policy();
      const nowMs = deps.clock();

      // Deterministic pre-effect gate BEFORE reservation (Codex #9): a target the
      // active policy does not admit never reserves and never charges budget.
      if (!targetAdmissible(policy, input, nowMs)) {
        throw new TcpCheckRefused("target is not permitted by the active policy");
      }

      // Staging-to-prepare drift (Codex #4): the digest approved at staging must
      // still match the active policy at prepare, otherwise the approval is stale.
      if (computeAllowlistDigest(policy.allowlist) !== identity.approvedAllowlistDigest) {
        throw new TcpCheckRefused("active policy has drifted since this action was approved");
      }

      const owner = identity.owner;
      // The binding store can be shared across owners and provider instances.
      // A process-local counter and clock tick cannot identify a reservation.
      const attemptId = randomUUID();

      // Atomic reservation (no budget yet — budget is charged at `started`).
      const reserved = await deps.admission.transition(owner, (state) =>
        reserve(state, {
          attemptId,
          nowMs,
          policyEpoch: policy.policyEpoch,
          ...(deps.rateConfig ? { config: deps.rateConfig } : {}),
        }),
      );
      if (!reserved.ok) {
        throw new TcpCheckRefused(`admission refused: ${reserved.reason}`);
      }

      const claim: EgressClaim = freezeClaim({
        owner,
        project: identity.project,
        actionFingerprint: identity.actionFingerprint,
        target: { ip: input.ip, port: input.port },
        fenceToken: reserved.fenceToken,
        policyEpoch: policy.policyEpoch,
        // The approved (staged) digest, carried through from the approval record.
        approvedAllowlistDigest: identity.approvedAllowlistDigest,
        deadlineMs,
        expiresAtMs: nowMs + leaseMs,
      });

      // Persist the attempt's trusted binding. It covers every authoritative
      // field, so a claim later mutated in place (blocked by the freeze) OR
      // replaced with a fabricated copy is rejected at sendPrepared (round 4 #1).
      try {
        await bindings.put(attemptId, { binding: computeClaimBinding(claim), retired: false });
      } catch (error) {
        // prepare has not returned and no send can have started this attempt.
        // A failed (or ambiguously committed) binding write must not strand its
        // reservation. The fence bump also prevents any old claim from starting.
        await deps.admission.transition(owner, (state) =>
          releaseReservation(state, { attemptId, fenceToken: reserved.fenceToken }),
        );
        throw error;
      }

      return Object.freeze({
        claim,
        attemptId,
        owner,
        providerRequestId: attemptId,
        providerCorrelationId: identity.correlationId,
      });
    },

    async releasePrepared(attempt): Promise<boolean> {
      const { owner, attemptId } = attempt;
      const claim = freezeClaim(attempt.claim);
      const record = await bindings.get(attemptId);
      if (
        record === null ||
        record.retired ||
        owner !== claim.owner ||
        record.binding !== computeClaimBinding(claim)
      ) {
        return false;
      }
      const outcome = await deps.admission.transition(owner, (state) =>
        releaseReservation(state, { attemptId, fenceToken: claim.fenceToken }),
      );
      if (outcome.ok) await bindings.remove(attemptId);
      return outcome.ok;
    },

    async sendPrepared(attempt, signal): Promise<TcpCheckReceiptSummary> {
      const { owner, attemptId } = attempt;
      // A structurally identical copy need not be frozen like prepare's return
      // value. Capture it once before authenticating: later caller mutations
      // across the fence/ledger awaits must not change the bound effect.
      const claim = freezeClaim(attempt.claim);
      const fenceToken = claim.fenceToken;
      const claimKey = computeClaimKey(claim);

      const summary = (
        outcome: EnforcerOutcome,
        admissionSignal: AdmissionSignal,
        storedOutcome?: SettledOutcome,
      ): TcpCheckReceiptSummary => ({
        status: outcome,
        // Derived from the immutable claim, never a post-effect policy read (Codex #8).
        target: `${claim.target.ip}:${claim.target.port}`,
        allowlistDigest: claim.approvedAllowlistDigest,
        admissionSignal,
        ...(storedOutcome ? { storedOutcome } : {}),
      });

      // Authenticate the prepared attempt against its durable reservation binding
      // before anything else. A mutated or fabricated/substituted claim (different
      // target port, wrong owner, absent record) is refused (round 4 #1).
      const expectedBinding = computeClaimBinding(claim);
      const record = await bindings.get(attemptId);
      if (record === null || record.binding !== expectedBinding || owner !== claim.owner) {
        return summary("not_authorized", "never-admitted");
      }
      // A retired (completed) attempt replays its recorded outcome WITHOUT running
      // the fence, gate, start or connect — honouring the completed-replay
      // contract while keeping permanent single-use retirement (round 4 #2).
      if (record.retired) {
        return summary("replayed", null, record.storedOutcome);
      }

      // Attempt-scoped self-cleanup: release only if the slot is still THIS
      // attempt's reservation, so a stale delivery never disturbs a later
      // attempt's slot (Codex #2).
      const selfCleanReservation = () =>
        deps.admission.transition(owner, (state) =>
          releaseReservation(state, { attemptId, fenceToken }),
        );
      const markOwnUncertain = (): Promise<unknown> =>
        deps.admission.transition(owner, (state) =>
          markUncertain(state, { attemptId, fenceToken }),
        );

      // Flip reserved -> started (charging budget) only after the fenced
      // pre-connect gate passes; otherwise self-clean the reservation with no
      // budget (Codex #9). The fence is keyed on the claim key — the same identity
      // the broker uses (Codex #1).
      // A rejection removes the binding (nothing crossed the egress boundary), so
      // a later delivery of the same attempt fails closed as `not_authorized`
      // rather than replaying — only a completed effect replays (round 4 #2).
      let fenceLive: boolean;
      try {
        fenceLive = await deps.fence.isActive(fenceToken, claimKey);
      } catch (error) {
        // A failed liveness read authorises no effect. Only an actually released
        // reservation permits deleting its binding; a duplicate must leave the
        // original started/uncertain attempt and its replay record untouched.
        const released = await selfCleanReservation();
        if (released.ok) await bindings.remove(attemptId);
        throw error;
      }
      if (!fenceLive) {
        const released = await selfCleanReservation();
        if (released.ok) await bindings.remove(attemptId);
        return summary("fence_superseded", released.ok ? "never-admitted" : null);
      }
      const gate = evaluatePolicyGate({ claim, policy: deps.policy(), nowMs: deps.clock() });
      if (!gate.ok) {
        const released = await selfCleanReservation();
        if (released.ok) await bindings.remove(attemptId);
        return summary(gate.reason, released.ok ? "never-admitted" : null);
      }

      const started = await deps.admission.transition(owner, (state) =>
        start(state, { attemptId, fenceToken, nowMs: deps.clock() }),
      );
      if (!started.ok) {
        // Our reservation is gone (a concurrent recovery), e.g. a duplicate
        // delivery reaching here after the original started/became uncertain.
        // Remove the binding ONLY if this invocation actually owned and released a
        // still-reserved attempt; otherwise leave the original's started/uncertain/
        // retired record and its replay tombstone untouched (Codex follow-up).
        const released = await selfCleanReservation();
        if (released.ok) await bindings.remove(attemptId);
        return summary("fence_superseded", released.ok ? "never-admitted" : null);
      }

      // From here the attempt is `started`. Any failure — including a thrown
      // dependency (e.g. ledger.begin) inside the enforcer — must leave the slot
      // held as `uncertain`, not stuck `started`, and must not leak a raw error
      // (Codex round 4 #2).
      let result;
      try {
        const enforcer = new BrokerEnforcer({
          policy: deps.policy,
          fence: deps.fence,
          ledger: deps.ledger,
          connector,
          clock: deps.clock,
        });
        result = await enforcer.authorizeAndConnect(claim, signal);
      } catch {
        await markOwnUncertain();
        return summary("effect_uncertain", null);
      }

      if (result.outcome === "effect_uncertain") {
        // Hold the slot, but move it started -> uncertain so a later enforcer
        // signal can resolve it (Codex #4). The binding stays non-retired so a
        // retry/replay re-enters the uncertain path rather than fabricating.
        await markOwnUncertain();
      } else {
        // Release the slot. `complete` is attempt+fence-conditional, so it only
        // releases a slot this attempt still holds (Codex #2/#3).
        const completed = await deps.admission.transition(owner, (state) =>
          complete(state, { attemptId, fenceToken }),
        );
        let released = completed.ok;
        if (
          !released &&
          (result.admissionSignal === "socket-closed" ||
            result.admissionSignal === "never-admitted")
        ) {
          // A concurrent recovery moved this attempt `started -> uncertain`, so
          // `complete` did not apply. Resolve the uncertain slot with the ACTUAL
          // returned signal (not an inferred one), carrying the genuine closure
          // evidence through (Codex follow-up).
          const resolved = await deps.admission.transition(owner, (state) =>
            resolve(state, { attemptId, signal: result.admissionSignal as ResolveSignal }),
          );
          released = resolved.ok;
        }
        if (released) {
          const settled = settledOutcomeOf(result);
          if (settled !== undefined) {
            // Completed effect: retire as a tombstone carrying the recorded
            // outcome so a legitimate completed replay returns it (round 4 #2).
            await bindings.put(attemptId, {
              binding: expectedBinding,
              retired: true,
              storedOutcome: settled,
            });
          } else {
            // A never-admitted race: nothing crossed; fail closed on any replay.
            await bindings.remove(attemptId);
          }
        }
        // If still not released (complete failed and there was no applicable
        // signal, e.g. a `replayed` result with a null signal): keep the slot
        // uncertain and the binding non-retired, so a later enforcer signal
        // resolves it via resolveUncertain — never retire an unreleased slot.
      }

      return summary(result.outcome, result.admissionSignal, result.storedOutcome);
    },

    async resolveUncertain(owner, attemptId, signal): Promise<boolean> {
      // Apply the enforcer's durable closure signal to an attempt held uncertain.
      // Releases only its own slot (resolve is attempt-conditional); never infers
      // closure from elapsed time (Codex #4).
      const outcome = await deps.admission.transition(owner, (state) =>
        resolve(state, { attemptId, signal }),
      );
      if (outcome.ok) {
        // Retire the binding as a tombstone. The network effect was never
        // recorded (it was uncertain), so a replay reports `replayed` with no
        // stored outcome rather than re-attempting.
        const record = await bindings.get(attemptId);
        await bindings.put(attemptId, { binding: record?.binding ?? "", retired: true });
      }
      return outcome.ok;
    },
  };
}

/**
 * Production wiring. Returns `null`: the capability is `planned`, so no provider
 * is registered and no real socket can be opened. Commissioning requires
 * separate owner approval per the design's Gates and #779.
 */
export function createTcpCheckProviderFromEnv(): TcpCheckProvider | null {
  return null;
}
