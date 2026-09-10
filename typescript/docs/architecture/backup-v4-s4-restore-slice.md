# S4 projects and notes: isolated restore adapter increment

This extends the existing v4 restore module with `verifyRestoredS4ProjectNotes`.
It uses the existing verification method and `groupChecksum`, but returns
`completeness: partial` and `verifiedGroups: []`. A two-table slice cannot seal
`notesAndEvidence`, even when every captured table is empty. Existing archive
coverage and full-recovery refusal remain unchanged.

`convex/backupS4Restore.ts` exports an **unregistered helper**, not a public
mutation. No deployment, CLI, automatic import, or provider connection is added.
Its caller must provide a single mutation transaction on an isolated database.
It requires existing owner and independent approval credentials, validates the
source owner, and refuses any nonempty application table, including foreign-owner
rows. It inserts only projects and notes through the existing persisted schemas;
it never invokes ordinary create/approval/reconciliation operations. Failure
rolls back the transaction; retry starts with an empty target.

The source must be a canonical, checksummed S4 capture with the exact 17-table
inventory and existing byte/row bounds. Every other table must be empty. Project
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
`ConvexNoteStore` instances. It compares ordinary reads with the strict capture
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

## Remaining S4 graph classification

The following inventory extends the capture contract. These tables remain
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

The next closed increment should classify projectRecords kinds and their nested
references, then add them with memoryChangeSets as a connected revision/history
unit. Action/receipt/reconciliation restore needs an explicit inert operational
representation before it is safe. Development bindings cannot be called verified
until S5 is present. None of these remaining edges is waived by this document.
