// The pure, deterministic pre-connect policy gate for `security:tcp-check`,
// shared by the provider (the pre-`started` self-cleanup check) and the egress
// mediator (the authoritative boundary check). Keeping it in one place means the
// two layers cannot drift, and the enforcer evaluates it from a clock and policy
// read *after* its awaits, immediately before connect (Codex #2) rather than
// from values captured earlier.
//
// It folds in table-anchor verification (Codex #6 — the authoritative boundary
// must refuse unless the special-use table matches the trusted anchor) and the
// approved-digest binding (Codex #4 — the active policy must still hash to the
// digest approved for this claim). Fence liveness, abort, and single-use
// consumption are not here: they need the enforcer's async ports.

import { parseCanonicalAddress } from "./address.js";
import { isAllowlisted } from "./allowlist.js";
import { computeAllowlistDigest } from "./allowlistDigest.js";
import type { EgressClaim } from "./egressClaim.js";
import type { PolicyView } from "./policy.js";
import { evaluateFreshness } from "./freshness.js";
import {
  isSpecialUse,
  SPECIAL_USE_TABLE_SNAPSHOT_DATE,
  verifySpecialUseTable,
} from "./specialUseTable.js";

export type GateRejection = "expired" | "policy_changed" | "not_authorized";

export type GateResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: GateRejection };

export interface GateInput {
  readonly claim: EgressClaim;
  readonly policy: PolicyView;
  readonly nowMs: number;
}

/**
 * Evaluate the deterministic policy gate. Order is fail-closed: table integrity,
 * then capability expiry, then the approved-policy binding (epoch + digest),
 * then the target (canonical, non-special-use, allowlisted), then freshness.
 */
export function evaluatePolicyGate(input: GateInput): GateResult {
  const { claim, policy, nowMs } = input;

  // Table anchor must verify at the authoritative boundary, not only at load.
  try {
    verifySpecialUseTable();
  } catch {
    return { ok: false, reason: "not_authorized" };
  }

  if (!Number.isFinite(nowMs) || nowMs > claim.expiresAtMs) {
    return { ok: false, reason: "expired" };
  }
  if (policy.policyEpoch !== claim.policyEpoch) {
    return { ok: false, reason: "policy_changed" };
  }
  // Bind the effect to the approved policy *content*, not just the epoch counter.
  if (computeAllowlistDigest(policy.allowlist) !== claim.approvedAllowlistDigest) {
    return { ok: false, reason: "policy_changed" };
  }
  const address = parseCanonicalAddress(claim.target.ip);
  if (address === null || isSpecialUse(address)) {
    return { ok: false, reason: "not_authorized" };
  }
  if (!isAllowlisted(policy.allowlist, claim.target.ip, claim.target.port)) {
    // A valid target the active policy no longer admits is a control-plane change.
    return { ok: false, reason: "policy_changed" };
  }
  // Freshness is bound to the anchor-verified table's own snapshot date, never a
  // caller-supplied value (Codex round 4 #3).
  if (
    !evaluateFreshness({
      snapshotDate: SPECIAL_USE_TABLE_SNAPSHOT_DATE,
      nowMs,
      maxAgeMs: policy.maxAgeMs,
    }).fresh
  ) {
    return { ok: false, reason: "policy_changed" };
  }
  return { ok: true };
}
