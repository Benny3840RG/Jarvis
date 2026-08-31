# JARVIS_TRANSITIONS

Status: canonical transition grammar
Initial domain: Development

Transition IDs are stable API identifiers used by implementation, tests, logs, policy, HUD projections, and audit. Existing IDs must not be silently redefined.

## Global side-effect classes

| Class | Meaning |
|---|---|
| S0 | observation/read only |
| S1 | internal reversible state |
| S2 | internal consequential state |
| S3 | external reversible effect |
| S4 | external consequential effect |
| S5 | irreversible/high-impact effect |

Default policy intent:
- S0: automatic subject to read authority;
- S1: automatic within valid capability envelope;
- S2: deterministic policy decision;
- S3: governed execution and reconciliation;
- S4: approval normally required unless explicitly delegated;
- S5: explicit operator authority required.

## Failure classes

- `REJECTED`: transition not admissible; authoritative source state remains unchanged.
- `FAILED`: valid operation began and evidence establishes failure.
- `INDETERMINATE`: valid operation may have produced an effect, but outcome is not proven; reconciliation required.

These are not interchangeable.

## Actor roles

Every committed transition records, where applicable:

- `requested_by`: actor/subsystem asking for change;
- `evaluated_by`: deterministic gate evaluating admissibility;
- `authorised_by`: authority granting permission;
- `committed_by`: sole authoritative writer for the state transition.

## Development states

`IDEA | SPECIFIED | READY | CLAIMED | BUILDING | VERIFYING | REPAIR_REQUIRED | REVIEW | READY_TO_MERGE | MERGED | RECONCILIATION_OPEN | ABORTED | COMPLETE`

`COMPLETE` is terminal and ΩΣ-owned.

---

## DEV_TRANSITION_SPECIFIED_TO_READY

- Domain: Development
- From: `SPECIFIED`
- To: `READY`
- Initiator: Development Controller
- Evaluated by: deterministic issue/spec validator
- Authorised by: policy within mission envelope
- Committed by: Development Controller
- Side-effect class: S1
- Reversible: yes, by governed transition back to specification work (future transition; not Phase 1 auto-path)
- Approval: none
- Gate:
  - objective non-empty;
  - acceptance criteria non-empty;
  - invariant IDs valid;
  - risk class in 0..3;
  - authority envelope present;
  - dependencies satisfied or explicitly waived by policy.
- Evidence: validated issue/spec snapshot and validator result.
- Retry: validator operation may retry; transition commit is single/idempotent.
- Reject when: malformed spec, unknown invariant, unsatisfied dependency, absent authority envelope.
- Related invariants: JARVIS-011, JARVIS-012, JARVIS-014.

## DEV_TRANSITION_READY_TO_CLAIMED

- Domain: Development
- From: `READY`
- To: `CLAIMED`
- Initiator: Worker Allocator / Development Controller
- Evaluated by: claim/lease gate
- Authorised by: Control Plane policy
- Committed by: Development Controller
- Side-effect class: S2
- Reversible: yes via abort/release path
- Approval: none within permitted development authority
- Gate:
  - mission remains READY;
  - no active incompatible claim;
  - worker identity valid;
  - capability envelope is a subset of mission authority;
  - lease expiry is server-derived and future-dated.
- Evidence: worker identity, claim ID, lease ID, capability envelope hash.
- Reject when: stale/duplicate claim, invalid worker, authority expansion, expired lease.
- Related invariants: JARVIS-007, JARVIS-013, JARVIS-017.

## DEV_TRANSITION_CLAIMED_TO_BUILDING

- Domain: Development
- From: `CLAIMED`
- To: `BUILDING`
- Initiator: Worker
- Evaluated by: lease + authority + branch gate
- Authorised by: existing valid claim
- Committed by: Development Controller
- Side-effect class: S2
- Reversible: yes via `DEV_TRANSITION_BUILDING_TO_ABORTED`
- Approval: none
- Gate:
  - valid unexpired lease exists;
  - claim belongs to requesting worker;
  - capability envelope covers target branch/repository scope;
  - branch metadata exists;
  - mission remains CLAIMED.
- Evidence: execution claim, lease, branch metadata.
- Retry: branch/setup operations may retry; state transition is committed once.
- Reject when: lease invalid, authority mismatch, branch absent, state mismatch.
- Related invariants: JARVIS-007, JARVIS-013, JARVIS-016, JARVIS-017.

## DEV_TRANSITION_BUILDING_TO_VERIFYING

- Domain: Development
- From: `BUILDING`
- To: `VERIFYING`
- Initiator: Builder / Development Controller
- Evaluated by: build artefact gate
- Authorised by: mission authority
- Committed by: Development Controller
- Side-effect class: S1
- Reversible: no direct reversal; verification may route to repair
- Approval: none
- Gate:
  - build/change set exists;
  - branch/head identity captured;
  - builder run has durable result/trace;
  - no expired worker authority used to create uncommitted effects.
- Evidence: build receipt, branch/head SHA, changed-file summary.
- Reject when: no durable build artefact, worker authority mismatch, stale branch identity.
- Related invariants: JARVIS-004, JARVIS-012, JARVIS-017.

## DEV_TRANSITION_VERIFYING_TO_REPAIR_REQUIRED

- Domain: Development
- From: `VERIFYING`
- To: `REPAIR_REQUIRED`
- Initiator: Verifier
- Evaluated by: deterministic verification policy
- Authorised by: mission authority
- Committed by: Development Controller
- Side-effect class: S1
- Reversible: yes by repair completion returning to BUILDING/VERIFYING through governed path
- Approval: none
- Gate: at least one required verification gate has established failure.
- Evidence: failing test/check identifiers, run IDs, head SHA.
- Failure semantic: this is not mission `FAILED`; it records actionable failed verification.
- Related invariants: JARVIS-004, JARVIS-015.

## DEV_TRANSITION_REPAIR_REQUIRED_TO_BUILDING

- Domain: Development
- From: `REPAIR_REQUIRED`
- To: `BUILDING`
- Initiator: Repair allocator/controller
- Evaluated by: repair-attempt and authority gate
- Authorised by: mission authority
- Committed by: Development Controller
- Side-effect class: S1
- Reversible: yes via abort path
- Approval: none while max repair attempts not exceeded
- Gate:
  - repair finding IDs exist;
  - repair attempts below configured maximum;
  - valid worker claim/lease available;
  - authority envelope unchanged or reduced.
- Evidence: review/verification finding IDs and repair-attempt counter.
- Reject when: attempt budget exhausted, authority expansion, invalid lease.
- Related invariants: JARVIS-007, JARVIS-016, JARVIS-017.

## DEV_TRANSITION_VERIFYING_TO_REVIEW

- Domain: Development
- From: `VERIFYING`
- To: `REVIEW`
- Initiator: Verifier / Controller
- Evaluated by: required-check policy
- Authorised by: mission authority
- Committed by: Development Controller
- Side-effect class: S1
- Reversible: no direct reversal; review may return to repair
- Approval: none
- Gate: all mandatory verification gates have current passing evidence for the same head SHA.
- Evidence: verification run IDs and policy result.
- Reject when: missing/stale/failing verification evidence.
- Related invariants: JARVIS-004, JARVIS-011.

## DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED

- Domain: Development
- From: `REVIEW`
- To: `REPAIR_REQUIRED`
- Initiator: Independent Reviewer
- Evaluated by: review finding policy
- Authorised by: mission authority
- Committed by: Development Controller
- Side-effect class: S1
- Reversible: through governed repair loop
- Approval: none
- Gate: one or more blocking review findings exist.
- Evidence: review ID, blocking finding IDs, reviewed head SHA.
- Related invariants: JARVIS-004, JARVIS-015.

## DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE

- Domain: Development
- From: `REVIEW`
- To: `READY_TO_MERGE`
- Initiator: Independent Reviewer / Controller
- Evaluated by: review + architecture-invariant gate
- Authorised by: Control Plane policy
- Committed by: Development Controller
- Side-effect class: S2
- Reversible: yes if new evidence invalidates readiness
- Approval: readiness itself does not merge; merge approval handled separately
- Gate:
  - independent review current for head SHA;
  - no blocking finding;
  - required constitutional/invariant checks passed;
  - required verification remains current.
- Evidence: review result, invariant-check result, verification evidence.
- Reject when: blocking finding, stale head, invariant violation, missing verification.
- Related invariants: JARVIS-001, JARVIS-011, JARVIS-018.

## DEV_TRANSITION_READY_TO_MERGE_TO_MERGED

- Domain: Development
- From: `READY_TO_MERGE`
- To: `MERGED`
- Initiator: Merge Executor
- Evaluated by: risk + approval + head-integrity gate
- Authorised by:
  - Risk 0: policy may authorise after required evidence;
  - Risk 1: guarded autonomy policy;
  - Risk 2: explicit operator/authorised reviewer approval;
  - Risk 3: explicit operator authority only.
- Committed by: Development Controller after merge receipt is reconciled
- Side-effect class: S4
- Reversible: not by state rollback; code may require a separate revert mission/action
- Approval: risk-dependent as above
- Gate:
  - current head SHA equals reviewed/verified SHA;
  - risk policy satisfied;
  - required approval valid and unexpired;
  - merge operation uses governed external-effect path;
  - provider outcome reconciled sufficiently to establish merged state.
- Evidence: approval (if required), merge request, provider receipt, observed merged commit SHA.
- Operation outcomes:
  - provider establishes rejection before side effect -> `REJECTED` operation result, state remains READY_TO_MERGE;
  - provider establishes failed merge -> `FAILED` operation result, state remains READY_TO_MERGE or routes to repair depending evidence;
  - provider timeout/ambiguous result -> `INDETERMINATE`, open reconciliation; do not assume merged/not merged.
- Related invariants: JARVIS-003, JARVIS-005, JARVIS-015, JARVIS-016.

## DEV_TRANSITION_MERGED_TO_RECONCILIATION_OPEN

- Domain: Development
- From: `MERGED`
- To: `RECONCILIATION_OPEN`
- Initiator: Post-merge observer / Evidence Plane
- Evaluated by: evidence-conflict/incompleteness gate
- Authorised by: reconciliation policy
- Committed by: Reconciliation authority/controller
- Side-effect class: S1
- Reversible: resolved by reconciliation transition
- Approval: none
- Gate: post-merge required evidence is missing, conflicting, or establishes a material problem.
- Evidence: post-merge observation and discrepancy description.
- Related invariants: JARVIS-004, JARVIS-005, JARVIS-008.

## DEV_TRANSITION_RECONCILIATION_OPEN_TO_MERGED

- Domain: Development
- From: `RECONCILIATION_OPEN`
- To: `MERGED`
- Initiator: Reconciler
- Evaluated by: reconciliation proof gate
- Authorised by: reconciliation policy
- Committed by: Reconciliation authority/controller
- Side-effect class: S1
- Reversible: reconciliation may reopen on new contradictory evidence
- Approval: none unless reconciliation action itself requires approval
- Gate: discrepancy resolved without proving mission completion; merged state is once again an accurate projection.
- Evidence: reconciliation record and resolved evidence references.
- Related invariants: JARVIS-005, JARVIS-008.

## DEV_TRANSITION_MERGED_TO_COMPLETE

- Domain: Development
- From: `MERGED`
- To: `COMPLETE`
- Initiator: Mission Engine may request ΩΣ evaluation
- Evaluated by: ΩΣ completion policy
- Authorised by: ΩΣ completion contract; any required external/operator approvals must already exist as evidence
- Committed by: **ΩΣ only**
- Side-effect class: S2
- Reversible: terminal for the mission version; subsequent defects create new evidence/mission work rather than rewriting historical completion
- Approval: no substitute approval may bypass ΩΣ
- Gate:
  - all declared acceptance criteria have current passing proofs/evidence;
  - post-merge evidence requirements satisfied;
  - no unresolved critical contradiction;
  - no open reconciliation blocking completion;
  - policy requirements satisfied.
- Evidence: ΩΣ evaluation referencing authoritative current proofs/evidence.
- Reject/defer when: missing evidence, contradiction, open reconciliation, failed criterion, stale proof.
- Related invariants: JARVIS-001, JARVIS-004, JARVIS-008, JARVIS-018.

## DEV_TRANSITION_BUILDING_TO_ABORTED

- Domain: Development
- From: `BUILDING`
- To: `ABORTED`
- Initiator: Controller, authorised operator, or policy-triggered lease/mission abort
- Evaluated by: abort policy
- Authorised by: Control Plane
- Committed by: Development Controller
- Side-effect class: S2
- Reversible: no direct continuation; resumption creates a fresh governed claim/mission path
- Approval: policy-dependent
- Evidence: abort reason, actor, current head/branch state, unresolved side-effect inventory.
- Gate: abort authority valid; any ambiguous external effects are routed to reconciliation rather than erased.
- Related invariants: JARVIS-005, JARVIS-012, JARVIS-017.
