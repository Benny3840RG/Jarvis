# ΩΣ Completion Integrity Requirements

Status: scoped governed extension
Date: 2026-08-19
Applies to: ΩΣ runtime state introduced after the frozen Jarvis v2.2 baseline
Related issue: #378

## Authority and scope

This document adds requirements only for the ΩΣ completion-integrity layer. It does **not** modify, reinterpret, or supersede the frozen Jarvis v2.2 requirements (`R-001`–`R-150`). Where this document and the frozen baseline overlap, the frozen baseline remains senior authority.

`omegaActionContracts` remains a bridge into Jarvis's existing governed `toolActions`, claims, receipts, and reconciliation path. Nothing in this document creates a second execution authority.

## Normative requirements

### OS-CI-001 — Acceptance criteria are definitions, not completion truth

An ΩΣ mission acceptance criterion is canonically identified by its `criterionId` and statement. Persisted `acceptanceCriteria[].status` and `acceptanceCriteria[].evidenceRefs` may remain temporarily for backward-compatible projection, but they are non-authoritative and MUST NOT be used to decide whether a mission may complete.

### OS-CI-002 — Validation proofs are authoritative

Every acceptance criterion MUST have at least one current passing `omegaValidationProofs` record before mission completion may succeed.

A passing proof is current only when:

- its criterion exists on the mission;
- it references at least one evidence record;
- every referenced evidence record exists in the same owner and mission scope; and
- every referenced evidence record is unexpired at completion time.

Missing, cross-scope, or expired proof evidence MUST make that proof unusable for completion.

### OS-CI-003 — Independent validation remains separately authorised

For R3 and R4 missions, every acceptance criterion MUST have a current passing proof with `independent: true`. Recording an independent proof MUST continue to require the dedicated approval-token boundary; the shared service credential alone is insufficient.

### OS-CI-004 — Failed validation remains fail-closed

A current validation proof with result `fail` MUST deny completion. `waived` and `inconclusive` proofs do not satisfy an acceptance criterion.

### OS-CI-005 — Critical contradictions remain fail-closed

Each current `certain` evidence record creates one contradiction edge for every evidence ID in its `contradicts` array. An unresolved current critical contradiction edge MUST deny completion.

Expiry of the contradicting evidence removes that edge from the current completion set but does not delete its history.

### OS-CI-006 — Contradiction resolution is append-only

A contradiction may become resolved only through a dedicated durable resolution entity. Resolution MUST NOT mutate or delete either original evidence record and MUST NOT be represented by ordinary evidence metadata.

Each resolution MUST be bound to exactly one contradiction edge:

- owner ID;
- mission ID;
- contradicting evidence ID; and
- contradicted evidence ID.

The contradicting evidence record MUST exist, the contradicted evidence record MUST exist, both MUST belong to the same owner and mission, and the contradicting evidence record MUST actually name the contradicted evidence ID in its `contradicts` array.

### OS-CI-007 — Resolution requires separate authority and audit identity

Creating a contradiction resolution MUST require both the normal owner-scoped service credential and the dedicated approval credential. The durable record MUST include a non-empty reason, a non-empty operator/reviewer identity, and a server-generated resolution timestamp.

### OS-CI-008 — Resolution IDs and edges are deterministic

A resolution ID replay with byte-equivalent governed contents MAY return the existing immutable record. Reusing a resolution ID with different contents MUST fail.

Only one resolution record may govern a specific contradiction edge. A second resolution ID targeting an already-resolved edge MUST fail. Concurrent attempts MUST converge to at most one durable winner under Convex transaction semantics.

### OS-CI-009 — Legacy mission documents remain safe

Existing mission rows that contain projected criterion `status` or `evidenceRefs` MUST remain readable. Completion MUST derive its decision from criterion definitions, current proofs, current evidence, contradiction resolutions, reconciliation state, and uncertainty policy instead of trusting those projected fields.

Malformed or ambiguous legacy state MUST fail closed rather than be silently normalised into completion.

### OS-CI-010 — External-effect governance is unchanged

Mission completion MUST continue to deny while bound external effects are unreconciled. `omegaActionContracts`, `toolActions`, single-use claims, `toolExecutionReceipts`, and reconciliation semantics remain unchanged by this increment.

### OS-CI-011 — Completion remains bounded

All completion-time reads of proofs, evidence, contradiction resolutions, and action contracts MUST use owner/mission-scoped indexes and bounded result limits. Exceeding a configured policy bound MUST deny completion rather than truncate silently.

### OS-CI-012 — No deployment or commissioning in this change

This integrity increment is repository-only. It MUST NOT deploy to Convex production, activate remote exposure, commission Outlook/Graph sending, add HTTP/MCP surfaces, or alter production authorisation.

## Completion truth

For this increment, the authoritative completion inputs are:

1. immutable mission criterion definitions;
2. current validation proofs backed entirely by current same-mission evidence;
3. unresolved current critical contradiction edges after applying valid append-only resolution records;
4. existing external-effect reconciliation state; and
5. residual uncertainty versus the mission uncertainty budget.

Projected criterion status/evidence fields are excluded from this list by design.
