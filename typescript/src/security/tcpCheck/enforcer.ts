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

    // 2. Single-use consumption is the FIRST authority check (Codex #2/#3): every
    //    rejection path — abort, fence, policy gate — is reached only after the
    //    ledger is consulted, so a duplicate delivery of an in-flight claim always
    //    returns `effect_uncertain` (and a settled one `replayed`), never a
    //    rejection that could free a still-pending slot. A fresh begin reserves
    //    the single use; any terminal below records it so a later delivery
    //    returns the stored status rather than another connect.
    let begin: BeginResult;
    try {
      begin = await this.deps.ledger.begin(claimKey, this.deps.clock());
    } catch {
      // A thrown ledger dependency leaves the single-use state unknown: fail
      // closed to an uncertain effect (no socket, slot held), never propagate the
      // raw error or admit (Codex round 4 #2).
      return { outcome: "effect_uncertain", admissionSignal: null };
    }
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

    // 3. Abort after consumption: no socket was opened, so record `cancelled`.
    if (isAborted(signal)) {
      await this.deps.ledger.finalize(claimKey, "cancelled", this.deps.clock());
      return { outcome: "cancelled", admissionSignal: "socket-closed" };
    }

    // 4. Fence liveness, checked AFTER the ledger await and immediately before the
    //    gate/connect (Codex #2) — so a fence superseded during the begin await is
    //    caught here. (True fence-to-syscall atomicity is the kernel/proxy
    //    enforcer's contract at commissioning; see the design cap and #779.)
    if (!(await this.deps.fence.isActive(claim.fenceToken, claimKey))) {
      await this.deps.ledger.finalize(claimKey, "refused", this.deps.clock());
      return NEVER_ADMITTED("fence_superseded");
    }

    // 5. Deterministic gate from a clock+policy read AFTER the awaits, right
    //    before connect (Codex #2).
    const gate = evaluatePolicyGate({
      claim,
      policy: this.deps.policy(),
      nowMs: this.deps.clock(),
    });
    if (!gate.ok) {
      await this.deps.ledger.finalize(claimKey, "refused", this.deps.clock());
      return NEVER_ADMITTED(gate.reason);
    }

    // 6. Final abort check immediately before the socket.
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
