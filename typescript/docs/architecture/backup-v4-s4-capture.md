# S4 transactional capture primitive

`backupS4.capture({ serviceToken, approvalToken })` is an owner-and-operator-authenticated, read-only Convex
query. One query transaction reads all 17 tables required by S4; each table uses
an existing index with the authenticated owner prefix. It never calls ordinary
mutation, reconciliation or restore paths. This is capture material, not a
restorable archive or an assertion of `notesAndEvidence` manifest coverage.

| Tables                                                                                                   | Durable data retained                                                                              |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| projects, projectRecords                                                                                 | Project identity and typed memory records, including nested payloads                               |
| notes                                                                                                    | Physical note IDs, contents, replay fingerprints and original metadata                             |
| developmentSubjects, developmentEvents                                                                   | Explicit bindings, generations, causal events and payloads                                         |
| runtimeEvents                                                                                            | Original sequence, correlation and metadata                                                        |
| toolActions, toolExecutionReceipts                                                                       | Approval expiry/revocation/consumption and execution outcomes, including optional legacy omissions |
| memoryChangeSets                                                                                         | Proposed, rejected, approved and applied memory history                                            |
| auditEvents, validationReports                                                                           | Recorded audit and validation evidence                                                             |
| externalReconciliations                                                                                  | Original outcome, lease and provider-reference history                                             |
| omegaMissions, omegaActionContracts, omegaEvidence, omegaValidationProofs, omegaContradictionResolutions | Mission definitions, bounded completion inputs, contracts, proofs and contradiction edges          |

The fixed envelope version is `archive-v4-s4-capture:v1`. `payloadJson` uses
Convex's own tagged JSON encoding, followed by canonical serialization and a
lossless decode comparison. This preserves bytes, int64, nonfinite floats and
negative zero. Unsupported or lossy values fail explicitly. `payloadSha256`
binds the complete payload, including owner, capture time, all named tables,
and every source document field. Empty tables are explicit. Documents are
ordered by source `_creationTime`, then `_id`; neither physical identity nor
original timestamps are rewritten. The checksum proves capture integrity only.

Existing `collectBounded` rejects more than 1,000 rows in any table. This
primitive additionally rejects more than 2,000 rows in total or 512 KiB of
encoded payload. A failed query returns no partial capture. Larger datasets need
a separately designed stable snapshot protocol; independently paginated queries
would not establish one transaction. No consistency with a separate JSON or
blob capture is implied.

Whole-row capture automatically retains optional mission
`completionAssessment` and `completionAssessmentCount` fields once present in
the deployed schema, together with their audit history. Tests verify lossless
encoding of this prospective metadata without importing an unmerged schema.
Source physical IDs make recorded context fingerprints stale after restore;
future restore must require fresh assessment, never hydrate authority from audit.

`restoreVerified` is always false. The ordinary v4 exporter still rejects
non-JSON capture, and full-recovery gates remain unchanged. S4 integration still
requires an empty-destination inert importer, explicit typed reference maps,
cross-S5 dependency handling, preserved ordering, failure recovery, ordinary
store read-back and matching restored digests. Logical IDs and opaque strings
must not be globally substituted. Preserved live lease/approval history is not
permission to reactivate it during restore. Treat capture payloads as private
backup material; this primitive does not write files or provision storage.

## Sensitive export authorization

Raw historical documents can contain active reconciliation lease capabilities and
Development request fingerprints containing submitted leases. Export therefore
requires both the service-owner token and the existing independent approval token
from the same deployment, checked before any table read. Ordinary service callers
cannot export this material. The existing token helper enforces credential separation
and rotation; there is no new approval service or restore authority.

Treat the returned payload as sensitive archive material: never log it, store any
future file output with mode `0600` in a private directory, and encrypt transfers and
off-host storage. This query creates no files. A future restore must make recovered
lease capabilities inert before normal stores are exposed; raw capture alone does
not prove recoverability or authorize replay.
