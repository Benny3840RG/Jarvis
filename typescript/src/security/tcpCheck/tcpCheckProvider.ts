// Governed external provider for `security:tcp-check` (design: Architecture /
// "the adapter … emits through the supervised egress mediator"; #779 Phase 4).
// This adapter is the only code that drives the effect: it reserves the
// owner-wide admission slot (Phase 2), writes the durable `started` record
// before any socket, then emits through the Phase 3 `BrokerEnforcer`, and maps
// the enforcer's admission signal back onto the slot. It emits **digest-only,
// redacted** results — the status enum plus the already-authorised `ip:port`
// and the server-computed `allowlistDigest`, never a pasted or resolved value.
//
// Commissioning posture: the default connector is {@link notCommissionedConnector},
// which fails closed — the capability is `planned`, not commissioned, so no real
// socket is ever opened. A real connector (and the kernel/proxy egress gate
// behind it) is supplied only under separate owner approval, together with a
// populated allowlist. {@link createTcpCheckProviderFromEnv} returns `null` so
// this provider is never spliced into the live tool-execution service.

import type { Allowlist } from "./allowlist.js";
import { isAllowlisted } from "./allowlist.js";
import { computeAllowlistDigest } from "./allowlistDigest.js";
import {
  emptyAdmissionState,
  complete,
  reserve,
  start,
  type AdmissionState,
  type RateConfig,
} from "./admission.js";
import { parseCanonicalAddress } from "./address.js";
import type { EgressClaim } from "./egressClaim.js";
import {
  BrokerEnforcer,
  type AdmissionSignal,
  type Connector,
  type EnforcerOutcome,
  type FenceChecker,
  type LedgerPort,
  type PolicyView,
} from "./enforcer.js";
import { isSpecialUse } from "./specialUseTable.js";

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

/** Durable per-owner admission state store (Convex in production; injected here). */
export interface AdmissionStore {
  get(owner: string): Promise<AdmissionState> | AdmissionState;
  put(owner: string, state: AdmissionState): Promise<void> | void;
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
  /** The already-authorised target; safe to echo (it was reviewed into the allowlist). */
  readonly target: string;
  readonly allowlistDigest: string;
  readonly admissionSignal: AdmissionSignal;
}

export interface TcpCheckProvider {
  readonly name: string;
  prepare(input: TcpCheckInput, identity: TcpCheckIdentity): Promise<TcpCheckPreparedAttempt>;
  sendPrepared(
    attempt: TcpCheckPreparedAttempt,
    input: TcpCheckInput,
  ): Promise<TcpCheckReceiptSummary>;
}

function targetPermitted(allowlist: Allowlist, input: TcpCheckInput): boolean {
  const address = parseCanonicalAddress(input.ip);
  return (
    address !== null && !isSpecialUse(address) && isAllowlisted(allowlist, input.ip, input.port)
  );
}

/**
 * The reference governed provider. It composes the already-tested admission
 * state machine and egress mediator; the orchestration here is the wiring, not
 * new policy. `prepare` reserves the slot and writes the durable `started`
 * record (per the design, `started` is written before the socket opens);
 * `sendPrepared` emits through the enforcer and releases the slot on a terminal
 * admission signal, or leaves it held when the effect is uncertain.
 */
export function createTcpCheckProvider(deps: TcpCheckProviderDeps): TcpCheckProvider {
  const connector = deps.connector ?? notCommissionedConnector;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_CONNECT_DEADLINE_MS;
  const leaseMs = deps.leaseMs ?? DEFAULT_CAPABILITY_LEASE_MS;

  return {
    name: TCP_CHECK_PROVIDER_NAME,

    async prepare(input, identity): Promise<TcpCheckPreparedAttempt> {
      const policy = deps.policy();
      const nowMs = deps.clock();

      // Defence in depth: the same deterministic gate the tool preflight runs.
      if (!targetPermitted(policy.allowlist, input)) {
        throw new TcpCheckRefused("target is not permitted by the active policy");
      }

      const owner = identity.owner;
      const attemptId = `${identity.actionFingerprint}:${nowMs}`;
      const current = (await deps.admission.get(owner)) ?? emptyAdmissionState();

      const reserved = reserve(current, {
        attemptId,
        nowMs,
        policyEpoch: policy.policyEpoch,
        ...(deps.rateConfig ? { config: deps.rateConfig } : {}),
      });
      if (!reserved.outcome.ok) {
        throw new TcpCheckRefused(`admission refused: ${reserved.outcome.reason}`);
      }
      const fenceToken = reserved.outcome.fenceToken;

      // `started` is written durably before any socket opens.
      const started = start(reserved.state, { attemptId, fenceToken, nowMs });
      if (!started.outcome.ok) {
        throw new TcpCheckRefused(`admission start failed: ${started.outcome.reason}`);
      }
      await deps.admission.put(owner, started.state);

      const claim: EgressClaim = {
        owner,
        project: identity.project,
        actionFingerprint: identity.actionFingerprint,
        target: { ip: input.ip, port: input.port },
        fenceToken,
        policyEpoch: policy.policyEpoch,
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

    async sendPrepared(attempt, input): Promise<TcpCheckReceiptSummary> {
      const enforcer = new BrokerEnforcer({
        policy: deps.policy,
        fence: deps.fence,
        ledger: deps.ledger,
        connector,
        clock: deps.clock,
      });
      const result = await enforcer.authorizeAndConnect(attempt.claim);

      // `effect_uncertain` is the SOLE held case: a socket may be in flight and
      // no durable outcome was recorded, so the slot stays held with no
      // time-based exit until a later enforcer signal resolves it. Every other
      // outcome is terminal and will not connect — a completed/failed/
      // timed-out/cancelled run (socket-closed), a never-admitted gate rejection,
      // or a settled/replayed duplicate that opens no socket — so the slot is
      // released now. (A settled replay carries a `null` signal but must still
      // release this attempt's slot, otherwise a duplicate delivery would wedge
      // the owner-wide slot forever.)
      const holdSlot = result.outcome === "effect_uncertain";
      if (!holdSlot) {
        const state = (await deps.admission.get(attempt.owner)) ?? emptyAdmissionState();
        const released = complete(state, {
          attemptId: attempt.attemptId,
          fenceToken: attempt.claim.fenceToken,
        });
        if (released.outcome.ok) {
          await deps.admission.put(attempt.owner, released.state);
        }
      }

      return {
        status: result.outcome,
        target: `${input.ip}:${input.port}`,
        allowlistDigest: computeAllowlistDigest(deps.policy().allowlist),
        admissionSignal: result.admissionSignal,
      };
    },
  };
}

/**
 * Production wiring. Returns `null`: the capability is `planned`, so no provider
 * is registered and no real socket can be opened. Commissioning (a real
 * connector + kernel/proxy egress gate + a populated, reviewed allowlist)
 * requires separate owner approval per the design's Gates and #779.
 */
export function createTcpCheckProviderFromEnv(): TcpCheckProvider | null {
  return null;
}
