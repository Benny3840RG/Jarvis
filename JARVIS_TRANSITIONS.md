# JARVIS Development Transition Guide

TRANSITIONS.yaml is the sole machine-readable transition authority. This
document explains it; runtime and tests must be aligned mechanically to that
file. An undeclared transition or unknown governing ID is rejected.

The Phase 1 states are IDEA, SPECIFIED, READY, CLAIMED, BUILDING, VERIFYING,
REPAIR_REQUIRED, REVIEW, READY_TO_MERGE, INDETERMINATE, MERGED, CONTRADICTED,
FAILED, ABORTED and COMPLETE.

Every transition records distinct requester, deterministic evaluator,
authoriser and committer. The commit path validates trusted identity, current
claim/lease/fencing, authority envelope, approval and current subject version
before it appends history. COMPLETE remains ΩΣ-only.

## DEV_TRANSITION_IDEA_TO_SPECIFIED

Validates the issue, objective, acceptance criteria and invariants before a
development mission becomes specified.

## DEV_TRANSITION_SPECIFIED_TO_READY

Admits a specified mission only after dependency, risk, capability and
verification policy checks have durable evidence.

## DEV_TRANSITION_READY_TO_CLAIMED

Creates one eligible worker claim and lease under the mission authority
envelope. Concurrent claims are version and fencing protected.

## DEV_TRANSITION_CLAIMED_TO_BUILDING

Starts work only for the current claimed worker with a live, non-superseded
lease and branch authority.

## DEV_TRANSITION_BUILDING_TO_VERIFYING

Moves a built change into verification when the implementation commit and
build receipt are present.

## DEV_TRANSITION_VERIFYING_TO_REPAIR_REQUIRED

Records conclusively failed verification as repair work, not as a completed
mission failure.

## DEV_TRANSITION_REPAIR_REQUIRED_TO_BUILDING

Returns authorised repair work to building while its repair budget remains.

## DEV_TRANSITION_VERIFYING_TO_REVIEW

Requires current passing verification evidence before independent review.

## DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED

Routes blocking independent-review findings back to repair.

## DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE

Requires independent review, constitutional checks, current risk and readiness
evidence. This is not a merge.

## DEV_TRANSITION_READY_TO_MERGE_TO_MERGED

Uses the governed merge execution path. Approval is bound to subject,
transition, proposal/effect, approved SHA, authority envelope and
decision-relevant policy fingerprint. Provider proof is required for MERGED.

## DEV_TRANSITION_READY_TO_MERGE_TO_INDETERMINATE

Records an attempted merge with an ambiguous external outcome. Time alone
cannot decide it; reconciliation is required.

## DEV_TRANSITION_INDETERMINATE_TO_MERGED

Accepts reconciliation only when authoritative external evidence proves the
merge occurred.

## DEV_TRANSITION_INDETERMINATE_TO_READY_TO_MERGE

Returns to merge readiness only when reconciliation proves no external effect
and the current governed retry path remains admissible.

## DEV_TRANSITION_INDETERMINATE_TO_CONTRADICTED

Preserves unresolved conflicting authoritative evidence rather than choosing a
convenient outcome.

## DEV_TRANSITION_INDETERMINATE_TO_FAILED

Records conclusive external failure after reconciliation when no safe retry
path remains.

## DEV_TRANSITION_MERGED_TO_COMPLETE

Only ΩΣ may commit completion, after post-merge observation, acceptance proof
and contradiction checks through the existing ΩΣ authority path.

## DEV_TRANSITION_REPAIR_REQUIRED_TO_FAILED

Terminates a mission only after the repair budget is exhausted and the failure
is conclusive.

## DEV_TRANSITION_ANY_ACTIVE_TO_ABORTED

Allows a controlled abort from an active state only when it cannot hide an
unreconciled external effect.
