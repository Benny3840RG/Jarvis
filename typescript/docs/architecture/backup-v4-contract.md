# Archive v4 contract (A2)

The accepted contract for complete business backup and recoverable restore.
Decisions here were made by Jarvis in response to the four questions raised by
`authoritative-domain-inventory.md`; this document records them and the staged
plan that implements them. Nothing here is a completion claim — see the
acceptance gate at the end, which only Jarvis can close.

## 1. Restore model — empty destination, logical identity preserved

Restore targets a **freshly reserved, empty destination**. A non-empty
destination is **refused** — never merged into, never overwritten.

**Logical IDs are preserved verbatim.** No universal remapping. Every
cross-domain reference in this schema is a logical string id (`clientId`,
`quoteId`, `buildId`, `runId`, …), so references need no rewriting at all.

**Physical IDs are a separate, explicit translation.** "Empty" does not
guarantee the platform will accept original physical ids, and in Convex it will
not: `ctx.db.insert(table, doc)` assigns `_id` itself and offers no way to
choose one. The translation surface is therefore:

| Physical id                                        | Scope                                                   | Handling                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quotePdfArtifacts.storageId` (`v.id("_storage")`) | **the only `v.id(...)` reference in the entire schema** | Explicit old→new translation map, applied when the blob is re-imported and the referencing row is written.                                                                                                                                                                                                                                 |
| Convex `_id`                                       | every table                                             | Re-assigned by the platform. Nothing in the schema references another row's `_id`, so no translation is needed — verified by scanning all three schema files.                                                                                                                                                                              |
| Convex `_creationTime`                             | every table                                             | Re-assigned. Every domain carries its own preserved `createdAt`; `_creationTime` is exposed in return validators, so clients will observe a changed value. Queries using `.withIndex(...)` order by index fields (preserved), not `_creationTime`. Any bare `.query(table).order(...)` without an index would reorder — checked per group. |

JSON-backed stores have no physical/logical split: their ids are logical and are
written verbatim.

## 2. Idempotency receipts — restored, and inert

Receipts and their **associated operation history** are restored, because
omitting them re-admits duplicate external effects.

Restored **consistently with** their requests, intents, delivery records and
reconciliation state — as a connected set, never as disconnected rows. Original
scope, fingerprints and timestamps are retained exactly.

Restoring a receipt must **not**:

- renew an expired approval,
- reactivate a lease,
- authorise execution.

Indeterminate outcomes are preserved **as indeterminate**, and reconciliation is
required before any retry. Restore reconstructs history; it never resumes an
external effect. Concretely, restored `orchestrationSteps` carry no live lease
(`leaseOwner` / `leaseToken` / `leaseExpiresAt` are not reinstated), restored
`toolActions` retain their recorded approval state and expiry rather than a
refreshed one, and a restored run in an indeterminate state stays indeterminate.

## 3. Blobs — exported, imported, and verified against their references

Authoritative file content is in scope. Metadata-only coverage does **not**
qualify as a complete backup where the bytes are needed for recovery.

- Export reads the blob bytes and records a digest alongside the reference.
- Import re-stores the bytes, obtains the new physical `storageId`, and writes
  the referencing row through the translation map.
- Verification recomputes the digest of the **restored** content and checks it
  against the **restored** reference. A reference without matching content, or
  content whose digest disagrees, fails the archive.

An artifact may be excluded as regenerable **only** where all of the following
are retained and recorded explicitly: every render input, the required
renderer and its version, and a _verified_ regeneration procedure. For quote
PDFs that means the `quoteRevisions` snapshot, the artifact's stored
`issuer` / `client` / `generatedAt`, and a pinned `rendererVersion` — because
`renderFinalizedQuotePdf` embeds `generatedAt` in the PDF `/CreationDate`, so a
re-render at any other time yields a different digest. Absent all of that,
missing bytes make the backup **incomplete**, not merely metadata-only.

## 4. One contract, staged by domain group, with a manifest

A single v4 archive contract. Implementation lands in stages by domain group.

Every archive carries a **versioned manifest**:

| Manifest field    | Purpose                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `contractVersion` | the v4 contract this archive claims                                                                          |
| `groups[]`        | each domain group present, with its schema version                                                           |
| `coverage`        | which required groups are present and which are absent                                                       |
| `counts`          | per-domain record counts                                                                                     |
| `checksums`       | per-group content digest, plus blob digests                                                                  |
| `dependencies`    | cross-group reference edges this archive asserts                                                             |
| `exclusions`      | every intentional exclusion, with its recorded recovery method                                               |
| `completeness`    | `complete` only when every required group **and** every cross-domain reference verifies; otherwise `partial` |

**A partial archive is unmistakably partial and is rejected by the
full-recovery path.** It may exist for staged development; it may not be
mistaken for a recovery image.

**Snapshot consistency must be proven, not assumed.** One archive wrapper does
not make its contents mutually consistent. Consistency across tables, files and
blobs is established by the capture mechanism and evidenced per group; a group
captured outside the consistent boundary is recorded as such in the manifest.

## Staged plan

| Stage | Group                                | Notes                                                                                                                                                                                           |
| ----- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | Manifest + contract scaffolding      | Manifest schema, `completeness` gating, partial-archive refusal in the full-recovery path. No domain coverage yet — every required group absent, so every archive is `partial` by construction. |
| S2    | Core + memory domains                | The eight sections v3 already covers, moved onto the v4 manifest with checksums and counts. Establishes parity before expansion.                                                                |
| S3    | Business records                     | clients, properties, projects, quotes, invoices, enquiries, errands + **business settings**. JSON-backed; identity verbatim.                                                                    |
| S4    | Notes + approval/evidence state      | notes, toolActions, toolExecutionReceipts, memoryChangeSets, auditEvents, validationReports, externalReconciliations, `omega*`. Convex-only. Receipt inertness rules from §2 apply here.        |
| S5    | Orchestration + idempotency receipts | orchestrationRuns/Steps/Reconciliations, directCreateReceipts, internalActionResults. Lease and indeterminate-state rules from §2 apply here.                                                   |
| S6    | Quote aggregate + blobs              | quoteRevisions, quoteDeliveryAttempts, quoteMigrationRecords, quotePdfArtifacts + Convex file storage. Physical-id translation and blob verification from §1/§3 apply here.                     |

Groups are built and tested incrementally. `completeness: complete` is only
reachable after S6 verifies, and only Jarvis decides whether it is accepted.

## Relationship to the parked archive-v4 prototype

An earlier prototype (`stash@{0}` on this machine) already implements, for the
JSON provider only: empty-destination reservation with refusal, verbatim
identity preservation, strict lossless readers, a lock-held coherent capture,
two-way restore verification, and an isolated-restore completion marker. Those
parts match §1 and are reusable.

It does **not** implement: the manifest, `completeness` gating, partial-archive
refusal, any Convex-backed group, blob export/import, physical-id translation,
receipts, or the inertness rules. It is a starting point for S2–S3, not a
candidate for the contract.

## Acceptance gate (Jarvis)

An archive is accepted only on proof of all of:

1. **Identity preservation** — every logical id restored verbatim.
2. **Reference integrity** — every cross-domain reference resolves after restore,
   including through the physical-id translation.
3. **Replay protection** — restored receipts still refuse a duplicate request.
4. **Blob integrity** — restored content digests match restored references.
5. **Interrupted-restore recovery** — an interruption leaves an unmistakably
   incomplete destination, never a partially-live one, and retry is safe.
6. **Absence of unintended external effects** — no approval renewed, no lease
   reactivated, no execution authorised, no message sent.

The existing ΩΣ completion authority and required human approvals are unchanged
by this contract. Neither worker may close this gate.
