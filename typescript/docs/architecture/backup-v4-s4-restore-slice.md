# S4 project memory: isolated restore adapter increments

This extends the existing v4 restore module with `verifyRestoredS4ProjectNotes`.
It uses the existing verification method and `groupChecksum`, but returns
`completeness: partial` and `verifiedGroups: []`. This closed slice cannot seal
`notesAndEvidence`, even when every captured table is empty. Existing archive
coverage and full-recovery refusal remain unchanged.

`convex/backupS4Restore.ts` exports an **unregistered helper**, not a public
mutation. No deployment, CLI, automatic import, or provider connection is added.
Its caller must provide a single mutation transaction on an isolated database.
It requires existing owner and independent approval credentials, validates the
source owner, and refuses any nonempty application table, including foreign-owner
rows. It inserts only projects, notes, supported projectRecords, terminal memoryChangeSets, never-approved rejected notes.create ToolActions and their typed auditEvents through the existing persisted schemas;
it never invokes ordinary create/approval/reconciliation operations. Failure
rolls back the transaction; retry starts with an empty target.

The source must be a canonical, checksummed S4 capture with the exact 17-table
inventory and existing byte/row bounds. Every unsupported table must be empty. The total across all supported tables remains capped at 2,000 rows. Project
keys and note project scopes must form a closed graph: each `notes.projectId`
resolves to a captured `projects.projectKey`. The normal note API permits scopes
without a project aggregate, so such captures are deliberately refused by this
first slice rather than called reference-complete. Duplicate project keys,
physical IDs, or scoped note idempotency keys are refused.

Source physical IDs are represented by separate typed projects/notes maps.
Source `_creationTime` remains in that map; Convex owns the new system clock.
Insertion follows captured creation-time order; verification requires the destination capture to retain that relative order. No logical ID, opaque note body,
fingerprint, replay key, timestamp, revision, or other document field is rewritten.
System-ID/creation-time normalization is applied only to each restored row's own
metadata when comparing the restored semantic payload with the source. This does
not claim to reproduce original system clocks. The source capture and identity
maps remain necessary for interpreting this partial verification result.

Verification reuses `backupS4.capture` with owner and approval credentials to
check the full destination S4 inventory and counts, then reads each restored
project/note through existing queries and fresh `ConvexTotalityJournal` /
`ConvexNoteStore` instances. Project records use the existing `listByKind` query;
change sets use `ConvexMemoryChangeSetService.get`; audit history uses `listByRequest`. It compares ordinary reads with the strict capture
and computes a new checksum from the lossless tagged encoding of those actual rows, checking logical project
edges, typed physical maps, duplicates and exact preserved fields. An extra row,
missing row, changed value or changed row between those reads fails verification.
The target must remain isolated throughout; this is not a live concurrent-write
snapshot protocol or a storage-blob reservation mechanism.

Tests use fresh `convex-test` databases with the real schema and query modules.
They prove new physical IDs, unchanged strings equal to old IDs, ordinary reads,
matching digests, duplicate-note replay protection, rejection of ambiguous or
unsupported captures, nonempty-target refusal, existing-schema rejection,
transaction rollback and safe retry. This is local adapter evidence only.

## Closed terminal memory history

The second increment admits projectRecords only for the existing memory definition
kinds: fact, assumption, measurement and decision. Wrapper kind/recordId must match
its definition; logical IDs are unique per project. Each project/kind group is
limited to the ordinary query's 100-row maximum, with complete readback required.
Component relationships, arbitrary attributes and other record kinds stay refused.

Only applied and rejected change sets are admitted. Definitions are validated by
the existing `normalizeMemoryRecords` and measurement uniqueness logic, and must
already match the producer's canonical values. Applied definitions resolve their
logical record IDs, but are not overwritten with newer current record values.
Rejected definitions are proposals; they do not invent references to records that
were never applied. Project revision, terminal timestamp and actor/history fields
are checked. Proposed and approved change sets remain unsupported because they
can become actionable through ordinary apply/approval operations.

Only the four `memory.change_set.proposed`, `.approved`, `.applied`, `.rejected`
audit producers are admitted, with exact payload shapes and matching change-set,
request, project, record IDs, revision, actor and timestamp data. Each terminal
change set must retain its required proposal/decision/application history. Other
audit events, missing history, unknown payload fields and duplicate history events
fail closed. Audit rows per request are limited to the ordinary reader's 100-row
maximum. Legacy history lacking these fields is refused by this increment rather
than silently repaired. Audit approval events are inert evidence, never replayed.

Ordinary grouped reads are compared completely with the captured restored rows,
including ordering, before tagged digest comparison. Tests build real histories
through stage/approve/apply/reject. Applied replay creates no rows, changes no
revision and adds no audit events; rejected apply refuses without changing data.
An older applied definition remains distinct from a later replacement record.
No live effect, approval, receipt or worker state has gained restore support.

## Closed rejected note proposals

The next increment admits only never-approved rejected `notes.create` proposals,
with T1 authority classification and `destructive: false`. Exact row keys exclude
all approval, expiry, revocation, consumption and claim fields. Existing note
argument validation and ToolAction canonical argument normalization validate the
original payload without rewriting it. The existing ToolAction stage safety-binding
producer is reused to check the stored binding; it is not recomputed into new authority.
Only exact `tool.action.proposed` and `tool.action.rejected` audits are admitted,
with matching logical action/request/project references, payloads, actors and clocks.
Action IDs and owner-wide proposal idempotency keys must be unique. Audit request
bounds apply across both memory and action history, not separately per producer.

Normal `toolActions.get` and fresh `ConvexToolActionService.get` readback join the
existing typed identity maps and tagged digest proof. Approval remains refused;
matching stage/reject replay keeps the action and all history unchanged. An
intentional denied execution drill occurs only **after** restore verification:
the existing executor adds its expected blocked decision receipt, while no tool
runs and all business/action/audit rows stay unchanged. This preserves existing
audit behavior; denial is not falsely described as a read-only operation. Such a
post-drill capture contains an unsupported receipt and cannot be reverified as
this closed slice. Existing fingerprints and opaque argument values are preserved.
Task/reminder create proposals and all target-ID operations, approved/revoked/expired
histories, receipts, reconciliations and worker state remain unsupported.

## Remaining S4 graph classification

The following inventory extends the capture contract. The closed memory subset below is now supported; other tables and producer forms remain
unsupported by the restore slice. Logical relationships are preserved by typed
scope, not by replacing strings matching a physical-ID map. Unclassified payloads
are explicit blockers to group verification.

| Table                         | Traced relationship and identity                                                                                                                                                              | Remaining restore requirement                                                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| projectRecords                | `projectRecords.upsert` resolves `projectKey` through projects and indexes `(owner, projectKey, recordId)`. `record.recordId` duplicates the logical record identity.                         | Validate duplicate wrapper/nested identity and project edge. `component.parentComponentId` is a candidate component relation, but its writer does not resolve it; component attributes and constraint values are arbitrary and require producer-specific classification. |
| memoryChangeSets              | `memoryChangeSets.recordsForChangeSet` resolves nested `records[].recordId` against projectRecords within the project. Base/applied revisions bind the project snapshot.                      | Restore proposals and applied records consistently; retain approval history without invoking apply/approve. Pending approved proposals must remain unable to execute during restore.                                                                                     |
| toolActions                   | `toolActions` uses logical `actionId`, `requestId`, project scope and idempotency key; approval/consumption fields and `singleUseClaimId` carry execution history.                            | Classify `arguments` by tool/operation and safety binding. Physical task/note/build IDs may be embedded in operation inputs; do not rewrite opaque arguments or mint replacement approval/fingerprint authority.                                                         |
| toolExecutionReceipts         | `toolExecutionReceipts.record` preserves caller receipt/action IDs and resolves replay by logical `receiptKey`. Optional legacy fields are allowed.                                           | Preserve receipt scope, action/effect fingerprints, indeterminate status and optional omissions. Trace operation-specific inputs together with action/reconciliation/S5 history before translating any physical reference.                                               |
| externalReconciliations       | `findReceipt` resolves `receiptKey` through the owner index; `receiptId` is the receipt's logical field, not `_id`. Action/execution/project keys are recorded alongside provider references. | Remove live lease capability from operational restored state without losing archived history; retain indeterminate/escalated outcomes. Provider IDs remain opaque. Resolve receipt/action links and safety binding before enabling ordinary stores.                      |
| developmentSubjects           | `developmentState` resolves logical `subjectId`, explicit Omega mission binding, orchestration run/node binding, and last event.                                                              | S5 is required for run/node edges. Preserve generations, fencing history and missing legacy bindings; do not infer completion from audit events.                                                                                                                         |
| developmentEvents             | Existing state queries scope event/request IDs by owner and subject. Causation/evidence IDs and arbitrary typed-event payloads are persisted with canonical request/event fingerprints.       | Classify every event producer, including payload lease data and physical IDs embedded in canonical request text. Preserve historical fingerprints as data; never replay them as fresh authority.                                                                         |
| runtimeEvents                 | `runtimeEvents` owns logical event IDs, sequence, correlation and event metadata.                                                                                                             | Preserve sequence and ordering; inventory metadata by event producer before claiming reference completeness.                                                                                                                                                             |
| auditEvents                   | `reasoningJournal` and other writers persist request/scope keys plus event-specific arbitrary payloads.                                                                                       | Scope is not uniformly a project foreign key. Inventory producers; audit evidence cannot hydrate authority or completion.                                                                                                                                                |
| validationReports             | `reasoningJournal` stores request/scope keys, checks and diagnostic strings.                                                                                                                  | Preserve request linkage and historical results; diagnostic text is opaque, not a global ID-remapping surface.                                                                                                                                                           |
| omegaMissions                 | Mission ID is logical; project key and acceptance-criterion IDs/evidence references define the mission graph.                                                                                 | Verify project/evidence edges. Preserve future assessment metadata as stale history; require fresh assessment rather than import completion authority.                                                                                                                   |
| omegaActionContracts          | `omegaActionContracts` resolves `toolActionId` using the action ID index. Mission/contract IDs, execution claim and reconciled receipt key are logical.                                       | Restore connected action/receipt history; preserve expiry and consumption. Scope is arbitrary and approval references require producer-specific classification.                                                                                                          |
| omegaEvidence                 | `omegaMissions.recordEvidence` resolves `contradicts[]` as mission-scoped logical evidence IDs. `sourceRef` is source-type-dependent.                                                         | Verify contradiction edges. Classify source references by source type; do not treat every sourceRef as a physical row ID.                                                                                                                                                |
| omegaValidationProofs         | `recordValidationProof` resolves criterion IDs and evidenceRefs within the mission; proof ID is logical.                                                                                      | Restore these edges together and retain historical validation without asserting present completion.                                                                                                                                                                      |
| omegaContradictionResolutions | Resolution writer verifies both mission-scoped evidence IDs and the actual contradiction edge.                                                                                                | Retain decision actor/time and edge; never invoke the approval-token resolution mutation during restore.                                                                                                                                                                 |

The next increment must classify the remaining projectRecords kinds and their nested
references. The terminal four-kind memory/history unit above is now supported. Action/receipt/reconciliation restore needs an explicit inert operational
representation before it is safe. Development bindings cannot be called verified
until S5 is present. None of these remaining edges is waived by this document.


## Joint S4 and mutable-quote proof (2026-09-11)

The existing backup surface now exposes `backupS4.captureJoint`: owner and separate
approval credentials authorize a single bounded Convex query over the union of
22 tables. Shared tables are read once and retain the smaller 100-row quote-side
bound. Both existing encoded materials use those exact arrays and one capture
timestamp. The JSON business digest binds the quote material to its source;
this is not a claim of an atomic snapshot across JSON and Convex.

The unregistered `restoreS4S6` primitive validates both supported sources, source
owners, typed physical identities and the exact shared action inventory before
inserting any row. It checks every application table is empty, including foreign
owner rows, then uses the existing typed insertion helpers within one Convex
transaction. A later quote insertion failure rolls back earlier S4 rows. The
standalone restore wrappers keep their original empty-target and unsupported-data
checks. Only the existing strict rejected-note-action classifier can admit shared
actions; receipts, reconciliations, active approvals and all other action forms
remain unsupported.

`verifyRestoredS4S6` reuses the ordinary S4/S6 store verifiers, a single joint
provider recapture, table-scoped identity maps, exact restored digests, and actual
JSON business-store verification before and after the proof. Equal capture
timestamps are a consistency check, not independent provenance. Corrupt rows,
identity maps, business references or normal reads fail verification. JSON and
Convex projects remain distinct namespaces even when their logical IDs match.

This is an isolated primitive and drill, not a public restore mutation or an
archive completion path. It returns `completeness: partial` and no whole-group
verification entries. The canonical archive payload and marker coordinator still
need integration before these materials can travel and recover as one archive.
Historical quote revisions, finalized quotes, PDFs, delivery ledgers, remaining
S4 evidence and S5 orchestration remain unsupported. No live restore, provider
commissioning, approval replay or new completion authority is introduced.
