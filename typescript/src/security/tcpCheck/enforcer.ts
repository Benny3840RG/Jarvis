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
// connector plus the kernel/proxy egress gate are commissioning prerequisites.
// Nothing here can open a real socket.
//
// Ordering (fail-closed), revised for the review findings:
//   abort? -> fence (await) -> single-use begin (await) -> re-read clock+policy
//   and run the deterministic gate SYNCHRONOUSLY -> abort? -> connect.
//
//   * The single-use ledger is consulted **before** the gate (Codex #3), so a
//     duplicate delivery of an in-flight claim returns `effect_uncertain` and a
//     settled one returns `replayed` — a gate rejection can never free a slot
//     whose effect is still pending.
//   * The time-sensitive gate (expiry / freshness / epoch / digest) is evaluated
//     from a clock and policy read **after** the awaits (Codex #2), so a pause
//     during the fence or ledger await cannot let a stale claim reach connect.
//   * The abort signal is honoured before consumption and again immediately
//     before connect (Codex #7).

import {
  computeClaimKey,
  validateEgressClaim,
  type EgressClaim,
  type EgressTarget,
} from "./egressClaim.js";
import { evaluatePolicyGate, type GateRejection } from "./gate.js";
import type { PolicyView } from "./policy.js";
import { type BeginResult, type SettledOutcome } from "./singleUseLedger.js";

export type { PolicyView } from "./policy.js";

/** The outcome the connector reports once a socket has run and been torn down. */
export type ConnectOutcome = "connected" | "refused" | "timed-out" | "error";

/**
 * The injected socket port. The mediator owns the socket, the deadline, and
 * cancellation; a real implementation (and the kernel/proxy egress gate behind
 * it) is a commissioning prerequisite and is never part of this module.
 */
export interface Connector {
  connect(target: EgressTarget, deadlineMs: number, signal?: AbortSignal): Promise<ConnectOutcome>;
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
  | ConnectOutcome // the socket ran: connected / refused / timed-out / error
  | "cancelled" // the attempt was aborted before/at the boundary
  | GateRejection // expired / policy_changed / not_authorized
  | "fence_superseded" // the attempt's token is no longer active
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
  authorizeAndConnect(claim: EgressClaim, signal?: AbortSignal): Promise<EnforcerResult>;
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

/** Read the live abort state (a function, so control flow is not narrowed away). */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Map a terminal connect/cancel outcome to the single-use ledger's settled form. */
function settledForm(outcome: ConnectOutcome | "cancelled"): SettledOutcome {
  return outcome;
}

/**
 * The Decision-0 reference enforcer. Pure composition over injected ports; it
 * never touches the network itself.
 */
export class BrokerEnforcer implements EgressEnforcer {
  constructor(private readonly deps: BrokerDependencies) {}

  async authorizeAndConnect(claim: EgressClaim, signal?: AbortSignal): Promise<EnforcerResult> {
    // 1. Well-formedness (fail-closed; a malformed claim is never-admitted).
    if (validateEgressClaim(claim) !== "ok") {
      return NEVER_ADMITTED("not_authorized");
    }
    const claimKey = computeClaimKey(claim);

    // 2. Abort before anything is consumed.
    if (isAborted(signal)) {
      return NEVER_ADMITTED("cancelled");
    }

    // 3. Fence liveness (await).
    if (!(await this.deps.fence.isActive(claim.fenceToken, claimKey))) {
      return NEVER_ADMITTED("fence_superseded");
    }

    // 4. Single-use consumption BEFORE the gate, so a duplicate of an in-flight
    //    or settled claim returns uncertain/replayed rather than a gate rejection
    //    that could free a still-pending slot (Codex #3).
    const begin = await this.deps.ledger.begin(claimKey, this.deps.clock());
    if (begin.kind === "invalid-input") {
      return NEVER_ADMITTED("not_authorized");
    }
    if (begin.kind === "replay-settled") {
      return {
        outcome: "replayed",
        admissionSignal: null,
        ...(begin.entry.outcome ? { storedOutcome: begin.entry.outcome } : {}),
      };
    }
    if (begin.kind === "replay-consuming") {
      return { outcome: "effect_uncertain", admissionSignal: null };
    }

    // 5. Deterministic gate evaluated from a clock+policy read AFTER the awaits,
    //    immediately before connect (Codex #2). A rejection here has already
    //    consumed the single use, so it is recorded as a terminal refusal — a
    //    later delivery returns the stored status, never another connect.
    const gate = evaluatePolicyGate({
      claim,
      policy: this.deps.policy(),
      nowMs: this.deps.clock(),
    });
    if (!gate.ok) {
      await this.deps.ledger.finalize(claimKey, "refused", this.deps.clock());
      return NEVER_ADMITTED(gate.reason);
    }

    // 6. Abort immediately before the socket (Codex #7). No socket was opened, so
    //    record a terminal `cancelled` and release the slot.
    if (isAborted(signal)) {
      await this.deps.ledger.finalize(claimKey, "cancelled", this.deps.clock());
      return { outcome: "cancelled", admissionSignal: "socket-closed" };
    }

    // 7. The mediator owns the socket and the deadline.
    let result: ConnectOutcome;
    try {
      result = await this.deps.connector.connect(claim.target, claim.deadlineMs, signal);
    } catch {
      // Crash/unknown between begin and a recorded result: leave the entry
      // `consuming` so any replay returns `effect_uncertain`; no signal, slot
      // stays held until a durable outcome arrives.
      return { outcome: "effect_uncertain", admissionSignal: null };
    }
    await this.deps.ledger.finalize(claimKey, settledForm(result), this.deps.clock());
    return { outcome: result, admissionSignal: "socket-closed" };
  }
}
