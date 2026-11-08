// The capability a worker presents to the supervised egress mediator (enforcer)
// for the Stage 3 `security:tcp-check` capability (design: "supervised egress
// mediator" / Architecture; #779 obligation 2). A claim carries a **stable
// identity** bound to the governed action and the owner/project, so the egress
// boundary can consume it exactly once. This module performs **no I/O**.
//
// The single-use key deliberately excludes the fence token and policy epoch: a
// recovered or duplicated delivery of the *same* approved action must hash to
// the *same* ledger entry so it returns the stored status (or `effect_uncertain`)
// rather than earning a second connect. The fence/epoch are checked separately,
// live, at the pre-connect gate.

import { canonicalJson } from "../../actions/canonicalJson.js";
import { sha256Hex } from "../../actions/sha256.js";

import { parseCanonicalAddress } from "./address.js";
import { MAX_PORT, MIN_PORT } from "./allowlist.js";

/** A canonical connect target: a canonical IP literal and an integer port. */
export interface EgressTarget {
  readonly ip: string;
  readonly port: number;
}

/** A single-use capability presented to the egress mediator. */
export interface EgressClaim {
  readonly owner: string;
  readonly project: string;
  /** Stable fingerprint of the approved governed action (Phase 4: exact_action_fingerprint). */
  readonly actionFingerprint: string;
  readonly target: EgressTarget;
  /** Live fence token for this attempt; checked at the gate, not part of the key. */
  readonly fenceToken: number;
  /** Policy epoch pinned at reservation; compared to the active epoch at the gate. */
  readonly policyEpoch: number;
  /** Connect deadline in ms (origin: the approved 5 s parameter), enforced on the socket. */
  readonly deadlineMs: number;
  /** Capability expiry in epoch ms; past this the mediator opens nothing. */
  readonly expiresAtMs: number;
}

export type ClaimValidationReason =
  | "ok"
  | "malformed-identity"
  | "malformed-target"
  | "bad-port"
  | "bad-fence"
  | "bad-epoch"
  | "bad-deadline"
  | "bad-expiry";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate a claim's shape, failing closed. Does not consult the live policy. */
export function validateEgressClaim(claim: EgressClaim): ClaimValidationReason {
  if (
    !isNonEmptyString(claim.owner) ||
    !isNonEmptyString(claim.project) ||
    !isNonEmptyString(claim.actionFingerprint)
  ) {
    return "malformed-identity";
  }
  if (
    typeof claim.target !== "object" ||
    claim.target === null ||
    parseCanonicalAddress(claim.target.ip) === null
  ) {
    return "malformed-target";
  }
  if (
    !isFiniteNumber(claim.target.port) ||
    !Number.isInteger(claim.target.port) ||
    claim.target.port < MIN_PORT ||
    claim.target.port > MAX_PORT
  ) {
    return "bad-port";
  }
  if (!isFiniteNumber(claim.fenceToken) || !Number.isInteger(claim.fenceToken)) {
    return "bad-fence";
  }
  if (!isFiniteNumber(claim.policyEpoch) || !Number.isInteger(claim.policyEpoch)) {
    return "bad-epoch";
  }
  if (!isFiniteNumber(claim.deadlineMs) || claim.deadlineMs <= 0) {
    return "bad-deadline";
  }
  if (!isFiniteNumber(claim.expiresAtMs)) {
    return "bad-expiry";
  }
  return "ok";
}

/**
 * The stable single-use key: a SHA-256 over the owner, project, approved action
 * fingerprint, and exact target. Independent of fence token and policy epoch, so
 * a replayed/duplicated delivery of the same approved action maps to one entry.
 */
export function computeClaimKey(claim: EgressClaim): string {
  return sha256Hex(
    canonicalJson({
      owner: claim.owner,
      project: claim.project,
      actionFingerprint: claim.actionFingerprint,
      ip: claim.target.ip,
      port: claim.target.port,
    }),
  );
}
