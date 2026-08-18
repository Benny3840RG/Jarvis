# ΩΣ Completion Integrity Architecture

Status: governed architecture
Date: 2026-08-19
Requirements: `docs/requirements/omega-sigma-completion-integrity.md`
Issue: #378

## Current truth

ΩΣ Pass 2 already persists mission acceptance criteria, evidence, validation proofs, and one-to-one action contracts. The existing runtime has two residual integrity problems:

1. `recordValidationProof` writes the authoritative proof and also mirrors derived `status` / `evidenceRefs` into `omegaMissions.acceptanceCriteria`. Completion currently reads that mirrored state, making duplicated data part of the authority path.
2. Current `certain` evidence with a non-empty `contradicts` list blocks completion, but there is no durable governed way to record that one contradiction was investigated and resolved.

The Jarvis external-effect boundary is already authoritative and is not redesigned here.

## Selected architecture — compatibility projection with authoritative proofs

Use a bounded compatibility migration rather than deleting mission fields immediately.

- `acceptanceCriteria[].criterionId` and `statement` remain canonical criterion definitions.
- Existing `status` and `evidenceRefs` fields remain in the mission schema for backward compatibility and may continue to be updated as a convenience projection.
- Completion logic MUST ignore those projected fields.
- `omegaValidationProofs` plus current `omegaEvidence` are the only source of criterion-validation truth.

This keeps old rows and callers readable while making divergence harmless to the completion gate. A future migration may remove the compatibility fields only after all consumers stop relying on them.

## Current-proof derivation

At completion time:

1. Read the mission's criterion definitions.
2. Read the bounded owner/mission proof set.
3. Read the bounded owner/mission evidence set.
4. Build the set of evidence records whose `validUntil` is absent or greater than the server completion time.
5. A proof is current only if it references at least one evidence ID and **every** referenced ID exists in that current evidence set.
6. Pass only current proofs into completion policy evaluation.
7. Require at least one current `pass` proof for every criterion.
8. For R3/R4, require at least one current passing proof with `independent: true` for every criterion.
9. Any current `fail` proof denies completion. `waived` and `inconclusive` proofs never satisfy a criterion.

This deliberately avoids trimming expired evidence out of a proof. A proof is an assertion over its complete evidence set; if part of that set is no longer current, that proof itself is no longer current.

## Contradiction edge model

`omegaEvidence.contradicts` defines directed contradiction edges:

`contradictingEvidenceId -> contradictedEvidenceId`

A current critical edge exists when the source evidence:

- belongs to the mission;
- is unexpired at completion time;
- has classification `certain`; and
- names the target evidence ID in `contradicts`.

A dangling target in malformed legacy data remains unresolved and therefore fail-closed.

## Append-only resolution entity

Add `omegaContradictionResolutions` as a dedicated table. Each row resolves exactly one contradiction edge and contains:

- `ownerId`
- `missionId`
- `resolutionId`
- `contradictionEvidenceId` — the source evidence carrying `contradicts`
- `contradictedEvidenceId` — the exact target ID named by that source
- `reason`
- `resolvedBy`
- `authority` — fixed audited authority class for the dedicated approval boundary
- `resolvedAt` — server-generated

Indexes:

- `by_owner_and_mission_id` for bounded completion reads;
- `by_owner_mission_and_resolution_id` for exact replay/conflict handling; and
- `by_owner_mission_and_contradiction_edge` for deterministic one-resolution-per-edge enforcement.

The original evidence rows are immutable. Resolution records are immutable. Nothing is updated in-place to say `resolved: true`.

## Resolution mutation

Expose a Convex mutation in `omegaContradictionResolutions.ts`.

The mutation:

1. authenticates the owner with the normal service token;
2. requires the dedicated approval token;
3. loads the mission by owner + mission ID;
4. refuses mutation after mission `complete` or `retired`;
5. validates non-empty resolution ID, reason, operator identity, and evidence IDs;
6. checks exact resolution-ID replay before any new write;
7. loads source and target evidence through owner/mission/evidence indexes;
8. requires both rows to exist in the same scope;
9. requires `source.contradicts` to contain the exact target ID;
10. rejects a different resolution ID for an already-resolved edge;
11. enforces the bounded per-mission resolution limit; and
12. inserts one immutable row with server time.

Convex transaction retries/OCC make concurrent different resolution attempts converge: after one wins, the other observes the edge as resolved and fails.

## Completion contradiction derivation

At completion time:

1. Read the bounded owner/mission resolution set.
2. Build a set of resolved edge keys from valid resolution rows.
3. For each current `certain` source evidence row, enumerate its `contradicts` target IDs.
4. An edge is resolved only when a matching resolution row exists for that exact source-target pair.
5. Count every unmatched edge as an unresolved critical contradiction.
6. Any non-zero count denies completion through the existing completion policy failure `critical-evidence-contradiction`.

Resolution of one edge never clears sibling contradictions emitted by the same source evidence.

## Pure completion policy

`typescript/src/omega/policy.ts` stops accepting criterion `status` and criterion-level `evidenceRefs` as inputs. Its criterion input becomes definition-only (`criterionId`). The policy evaluates only current proofs supplied by the Convex boundary.

This is an architectural enforcement mechanism: a caller cannot accidentally reintroduce projected mission state into completion without changing the policy interface and its tests.

## Compatibility and migration

No destructive data migration is required in this increment.

- Existing mission rows keep their projected fields.
- Existing callers may continue reading them.
- `recordValidationProof` may continue updating them as a compatibility projection.
- Completion ignores them.
- Existing evidence and proof rows remain unchanged.
- The new resolution table starts empty; therefore every existing current critical contradiction remains unresolved until an authorised resolution is explicitly recorded.

This is fail-closed and preserves history.

## Failure behaviour

- Missing current passing proof: deny completion.
- Proof references any missing or expired evidence at completion: proof is non-current; deny unless another current passing proof exists.
- R3/R4 lacks current independent passing proof: deny.
- Current failed proof: deny.
- Current critical contradiction without exact edge resolution: deny.
- Resolution references missing/cross-mission evidence: reject mutation.
- Resolution source does not actually contradict target: reject mutation.
- Same resolution ID, different contents: reject.
- Different resolution ID, same edge: reject.
- Resolution set exceeds bound: deny completion / reject further writes.
- Existing projected criterion state disagrees with proofs: projection may be stale, but completion follows proofs and current evidence.

## Non-goals

- No changes to `omegaActionContracts` architecture.
- No second execution, claim, receipt, or reconciliation path.
- No mission-state enum expansion.
- No HTTP, MCP, OpenAPI, or console surface.
- No production deployment, Convex production action, remote exposure, or Outlook/Graph commissioning.
