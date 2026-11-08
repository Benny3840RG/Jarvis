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

import {
  complete,
  emptyAdmissionState,
  recover,
  reserve,
  start,
  type AdmissionState,
  type RateConfig,
  type Transition,
} from "./admission.js";
import { parseCanonicalAddress } from "./address.js";
import { isAllowlisted } from "./allowlist.js";
import { computeAllowlistDigest } from "./allowlistDigest.js";
import type { EgressClaim } from "./egressClaim.js";
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
import { isSpecialUse, verifySpecialUseTable } from "./specialUseTable.js";

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
  sendPrepared(
    attempt: TcpCheckPreparedAttempt,
    signal?: AbortSignal,
  ): Promise<TcpCheckReceiptSummary>;
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
  return evaluateFreshness({ snapshotDate: policy.snapshotDate, nowMs, maxAgeMs: policy.maxAgeMs })
    .fresh;
}

export function createTcpCheckProvider(deps: TcpCheckProviderDeps): TcpCheckProvider {
  const connector = deps.connector ?? notCommissionedConnector;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_CONNECT_DEADLINE_MS;
  const leaseMs = deps.leaseMs ?? DEFAULT_CAPABILITY_LEASE_MS;
  let sequence = 0;

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

      const owner = identity.owner;
      sequence += 1;
      const attemptId = `${identity.actionFingerprint}:${nowMs}:${sequence}`;

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

      const claim: EgressClaim = {
        owner,
        project: identity.project,
        actionFingerprint: identity.actionFingerprint,
        target: { ip: input.ip, port: input.port },
        fenceToken: reserved.fenceToken,
        policyEpoch: policy.policyEpoch,
        approvedAllowlistDigest: computeAllowlistDigest(policy.allowlist),
        deadlineMs,
        expiresAtMs: nowMs + leaseMs,
      };

      return {
        claim,
        attemptId,
        owner,
        providerRequestId: attemptId,
        providerCorrelationId: identity.correlationId,
      };
    },

    async sendPrepared(attempt, signal): Promise<TcpCheckReceiptSummary> {
      const { claim, owner, attemptId } = attempt;

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

      // Flip reserved -> started (charging budget) only after the fenced
      // pre-connect gate passes; otherwise self-clean the reservation with no
      // budget (Codex #9). The authoritative re-check still runs in the mediator.
      const fenceLive = await deps.fence.isActive(claim.fenceToken, attemptId);
      if (!fenceLive) {
        await deps.admission.transition(owner, (state) => recover(state));
        return summary("fence_superseded", "never-admitted");
      }
      const gate = evaluatePolicyGate({ claim, policy: deps.policy(), nowMs: deps.clock() });
      if (!gate.ok) {
        await deps.admission.transition(owner, (state) => recover(state));
        return summary(gate.reason, "never-admitted");
      }

      const started = await deps.admission.transition(owner, (state) =>
        start(state, { attemptId, fenceToken: claim.fenceToken, nowMs: deps.clock() }),
      );
      if (!started.ok) {
        // Lost the race to another transition; refuse without an effect.
        await deps.admission.transition(owner, (state) => recover(state));
        return summary("fence_superseded", "never-admitted");
      }

      const enforcer = new BrokerEnforcer({
        policy: deps.policy,
        fence: deps.fence,
        ledger: deps.ledger,
        connector,
        clock: deps.clock,
      });
      const result = await enforcer.authorizeAndConnect(claim, signal);

      // Release the owner-wide slot on any terminal outcome except an uncertain
      // effect, which holds it with no time-based exit (Codex #3). `complete` is
      // fence-conditional, so it only releases a slot this attempt still holds.
      if (result.outcome !== "effect_uncertain") {
        await deps.admission.transition(owner, (state) =>
          complete(state, { attemptId, fenceToken: claim.fenceToken }),
        );
      }

      return summary(result.outcome, result.admissionSignal, result.storedOutcome);
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
