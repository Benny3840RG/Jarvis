// Supervised egress mediator (enforcer) for `security:tcp-check` — the
// enforcement point of record (design: Admission control R1 / Architecture;
// #779 obligations 1 & 2). Decision 0: a dedicated out-of-process enforcing
// broker whose running config *is* the compiled active policy; it re-runs the
// authoritative connect-time check, owns the socket, and consumes the single-use
// claim exactly once. It sits behind the {@link EgressEnforcer} port so a
// stronger kernel-level enforcer (nftables / eBPF) can replace it later.
//
// This module imports **no** `node:net` and ships **no** concrete network
// connector: the socket is an injected {@link Connector} port, and a real
// connector plus the kernel/proxy egress gate are commissioning prerequisites
// (the design's open item for obligation 1). Nothing here can open a real
// socket. The ordering is fixed and fail-closed:
//
//   validate claim → fence active? → not expired? → policy epoch matches? →
//   target still allowed + fresh? → **then** single-use consume → **then** connect.
//
// Single-use is consumed only after the pre-connect gate passes and before the
// socket, so a rejected or replayed claim never reaches the connector. Every
// outcome carries the admission signal the slot owner applies: `never-admitted`
// and `socket-closed` release the held slot; `null` (an uncertain effect) keeps
// it held, with no time-based exit (obligation 4).

import { parseCanonicalAddress } from "./address.js";
import { isAllowlisted, type Allowlist } from "./allowlist.js";
import {
  computeClaimKey,
  validateEgressClaim,
  type EgressClaim,
  type EgressTarget,
} from "./egressClaim.js";
import { evaluateFreshness } from "./freshness.js";
import { type BeginResult, type SettledOutcome } from "./singleUseLedger.js";
import { isSpecialUse } from "./specialUseTable.js";

/** The outcome the connector reports once a socket has run and been torn down. */
export type ConnectOutcome = "completed" | "failed" | "timed-out" | "cancelled";

/**
 * The injected socket port. The mediator owns the socket and the deadline; a
 * real implementation (and the kernel/proxy egress gate behind it) is a
 * commissioning prerequisite and is never part of this module.
 */
export interface Connector {
  connect(target: EgressTarget, deadlineMs: number): Promise<ConnectOutcome>;
}

/** The compiled active policy the mediator enforces at connect time. */
export interface PolicyView {
  readonly allowlist: Allowlist;
  readonly snapshotDate: string;
  readonly maxAgeMs: number;
  readonly policyEpoch: number;
}

/** Live check that the attempt's fence token has not been superseded. */
export interface FenceChecker {
  isActive(fenceToken: number, claimKey: string): boolean | Promise<boolean>;
}

/** The durable single-use ledger, as an atomic port over the pure reducer. */
export interface LedgerPort {
  begin(claimKey: string, nowMs: number): BeginResult | Promise<BeginResult>;
  finalize(claimKey: string, outcome: SettledOutcome, nowMs: number): void | Promise<void>;
}

export type EnforcerOutcome =
  | ConnectOutcome // the socket ran: completed / failed / timed-out / cancelled
  | "policy_changed" // target removed/narrowed, epoch moved, or table stale
  | "expired" // capability lifetime elapsed
  | "fence_superseded" // the attempt's token is no longer active
  | "not_authorized" // malformed/special-use/not-allowlisted target (fail-closed)
  | "replayed" // a settled claim replayed; stored outcome returned, no socket
  | "effect_uncertain"; // consuming replay or connector crash; no new socket

export type AdmissionSignal = "socket-closed" | "never-admitted" | null;

export interface EnforcerResult {
  readonly outcome: EnforcerOutcome;
  readonly admissionSignal: AdmissionSignal;
  /** Present only for `replayed`: the originally recorded terminal outcome. */
  readonly storedOutcome?: SettledOutcome;
}

/** The enforcement-point port: a worker presents a claim, nothing more. */
export interface EgressEnforcer {
  authorizeAndConnect(claim: EgressClaim): Promise<EnforcerResult>;
}

export interface BrokerDependencies {
  /** The compiled active policy, read fresh at each attempt. */
  readonly policy: () => PolicyView;
  readonly fence: FenceChecker;
  readonly ledger: LedgerPort;
  readonly connector: Connector;
  /** Trusted clock in epoch ms. */
  readonly clock: () => number;
}

const NEVER_ADMITTED = (outcome: EnforcerOutcome): EnforcerResult => ({
  outcome,
  admissionSignal: "never-admitted",
});

/**
 * The Decision-0 reference enforcer. Pure composition over injected ports; it
 * never touches the network itself.
 */
export class BrokerEnforcer implements EgressEnforcer {
  constructor(private readonly deps: BrokerDependencies) {}

  async authorizeAndConnect(claim: EgressClaim): Promise<EnforcerResult> {
    // 1. Well-formedness (fail-closed; a malformed claim is never-admitted).
    if (validateEgressClaim(claim) !== "ok") {
      return NEVER_ADMITTED("not_authorized");
    }

    const claimKey = computeClaimKey(claim);
    const nowMs = this.deps.clock();
    const policy = this.deps.policy();

    // 2. Fenced pre-connect gate — authoritative, at the egress boundary.
    if (!(await this.deps.fence.isActive(claim.fenceToken, claimKey))) {
      return NEVER_ADMITTED("fence_superseded");
    }
    if (nowMs > claim.expiresAtMs) {
      return NEVER_ADMITTED("expired");
    }
    if (policy.policyEpoch !== claim.policyEpoch) {
      return NEVER_ADMITTED("policy_changed");
    }
    const address = parseCanonicalAddress(claim.target.ip);
    if (address === null || isSpecialUse(address)) {
      return NEVER_ADMITTED("not_authorized");
    }
    if (!isAllowlisted(policy.allowlist, claim.target.ip, claim.target.port)) {
      // A validly-formed target that the active policy no longer allows is a
      // control-plane narrowing/removal, not a malformed input.
      return NEVER_ADMITTED("policy_changed");
    }
    if (
      !evaluateFreshness({
        snapshotDate: policy.snapshotDate,
        nowMs,
        maxAgeMs: policy.maxAgeMs,
      }).fresh
    ) {
      return NEVER_ADMITTED("policy_changed");
    }

    // 3. Single-use consumption — after the gate, before the socket.
    const begin = await this.deps.ledger.begin(claimKey, nowMs);
    if (begin.kind === "invalid-input") {
      return NEVER_ADMITTED("not_authorized");
    }
    if (begin.kind === "replay-settled") {
      // Duplicate delivery of a finished claim: return the stored status, open
      // nothing, and emit no new signal (the original attempt already resolved).
      return {
        outcome: "replayed",
        admissionSignal: null,
        ...(begin.entry.outcome ? { storedOutcome: begin.entry.outcome } : {}),
      };
    }
    if (begin.kind === "replay-consuming") {
      // A socket may have been opened and never recorded: uncertain, not a
      // reconnect. No signal — the slot stays held (obligation 4).
      return { outcome: "effect_uncertain", admissionSignal: null };
    }

    // 4. Fresh: the mediator owns the socket and the deadline.
    let result: ConnectOutcome;
    try {
      result = await this.deps.connector.connect(claim.target, claim.deadlineMs);
    } catch {
      // Crash/unknown between begin and a recorded result: leave the entry
      // `consuming` so any replay returns `effect_uncertain`; no signal, slot
      // stays held until a durable outcome arrives.
      return { outcome: "effect_uncertain", admissionSignal: null };
    }
    await this.deps.ledger.finalize(claimKey, result, this.deps.clock());
    return { outcome: result, admissionSignal: "socket-closed" };
  }
}
