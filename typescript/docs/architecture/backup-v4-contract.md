# Archive v4 contract (A2)

The accepted contract for complete business backup and recoverable restore.
Decisions here were made by Jarvis in response to the four questions raised by
`authoritative-domain-inventory.md`; this document records them and the staged
plan that implements them. Nothing here is a completion claim — see the
acceptance gate at the end, which only Jarvis can close.

## 1. Restore model — empty destination, logical identity preserved

Restore targets a **freshly reserved, empty destination**. A non-empty
destination is **refused** — never merged into, never overwritten.

**Logical IDs are preserved verbatim.** Physical IDs are translated explicitly,
including when stored in `v.string()` fields or nested state. A schema type
alone does not establish the identity semantics of a reference; its writers,
readers and provider adapters must be traced. No universal string remapping.

**Convex assigns new physical IDs.** `ctx.db.insert` does not accept an original
`_id`, and imported blobs receive new storage IDs. The known translation surface
includes the following; each later group must inventory additional references
before claiming verified coverage:

| Physical reference                                                | Evidence in current code                                                                                                                                                   | Required restore handling                                                                                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quotePdfArtifacts.storageId`                                     | Explicit `v.id("_storage")` field                                                                                                                                          | Translate old blob ID to imported blob ID and verify bytes/digest.                                                                                               |
| `buildLogs.buildId`, `upgrades.buildId`                           | `convex/buildOwnership.ts` resolves the value with `normalizeId("builds", ...)`                                                                                            | Translate using the source `builds` table's old-to-new ID map.                                                                                                   |
| `directCreateReceipts.entityId`                                   | `convex/tasks.ts` and `reminders.ts` store `_id` and resolve it with `normalizeId`                                                                                         | Translate according to the receipt's task/reminder entity type.                                                                                                  |
| `internalActionResults.entityId`, nested `result.id`              | The task/reminder handlers persist the same generated entity ID in both fields                                                                                             | Translate both references consistently, preserving receipt scope and fingerprints.                                                                               |
| IDs embedded in `assistantState`, including task/reminder objects | `src/persistence/convexPersistence.ts` exposes `_id` as public `id`; the CLI stores those objects. Existing `convex/assistantState.ts` restore already remaps nested state | Inventory reference fields and translate physical IDs with source-table context. Do not rewrite arbitrary matching strings or assume all nested IDs are logical. |
| Convex `_id` on every restored table                              | Assigned by the platform                                                                                                                                                   | Retain source identity in archive metadata and create table-scoped maps wherever references depend on it.                                                        |

`storageId` is the only explicit `v.id(...)` field in the schema definitions,
but it is not the only physical reference. A group with an unclassified or
ambiguous reference cannot claim reference integrity. Logical values such as
project keys and domain-generated operation IDs are preserved, not blindly
substituted through physical-ID maps. References and stored fingerprints must
remain mutually consistent without minting new approval or replay authority.

**Timestamp and ordering recovery are explicit.** Preserve recorded domain
clocks as data, but do not assume every table has `createdAt`: `assistantState`,
`projectRecords` and `orchestrationSteps` do not. Archive source `_creationTime`
where needed as historical metadata; normal Convex insertion assigns a new
system value. Convex uses `_creationTime` as the final tie-breaker in every
index, including custom indexes. A `by_owner` query with a fixed owner therefore
orders by that system clock; `convex/builds.ts` uses this pattern. A restore can
change list order, pagination and ties even when business timestamps survive.
Each group must verify its ordering behavior and specify how required source
ordering is retained or how a changed order is accepted. See the
[Convex index ordering contract](https://docs.convex.dev/database/reading-data/indexes/).

JSON store IDs are logical and the v4 restore path must write them verbatim.
Existing store `add()` APIs may generate replacement IDs, so empty-target
reservation alone is not evidence that an existing import API preserves them.

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
PDFs that means the Convex `quotes` aggregate (including its number), the
`quoteRevisions` snapshot, the artifact's stored
`issuer` / `client` / `generatedAt`, and a pinned `rendererVersion` — because
`renderFinalizedQuotePdf` embeds `generatedAt` in the PDF `/CreationDate`, so a
re-render at any other time yields a different digest. Absent all of that,
missing bytes make the backup **incomplete**, not merely metadata-only.

## 4. One contract, staged by domain group, with a manifest

A single v4 archive contract. Implementation lands in stages by domain group.

Every archive carries a **versioned manifest**:

| Manifest field    | Purpose                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contractVersion` | the v4 contract this archive claims                                                                                                                                  |
| `groups[]`        | each domain group present, with its schema version                                                                                                                   |
| `coverage`        | which required groups are present and which are absent                                                                                                               |
| `counts`          | per-domain record counts                                                                                                                                             |
| `checksums`       | per-group content digest, plus blob digests                                                                                                                          |
| `dependencies`    | cross-group reference edges this archive asserts                                                                                                                     |
| `exclusions`      | every intentional exclusion, with its recorded recovery method                                                                                                       |
| `verification`    | evidence of an isolated restore-and-read-back pass, or `null` when the archive has never been verified                                                               |
| `completeness`    | `complete` only when every required group is present, every cross-domain reference resolves, **and** `verification` covers every required group; otherwise `partial` |

**A partial archive is unmistakably partial and is rejected by the
full-recovery path.** It may exist for staged development; it may not be
mistaken for a recovery image.

**Snapshot consistency must be proven, not assumed.** One archive wrapper does
not make its contents mutually consistent. Consistency across tables, files and
blobs is established by the capture mechanism and evidenced per group; a group
captured outside the consistent boundary is recorded as such in the manifest.

## Staged plan

| Stage | Group                                            | Notes                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | Manifest + contract scaffolding                  | Manifest schema, `completeness` gating, partial-archive refusal in the full-recovery path. No domain coverage yet — every required group absent, so every archive is `partial` by construction.                                                                                                                              |
| S2    | Core + memory domains                            | The eight sections v3 already covers, moved onto the v4 manifest with checksums and counts. Establishes parity before expansion.                                                                                                                                                                                             |
| S3    | Business records                                 | clients, properties, projects, quotes, invoices, enquiries, errands + **business settings**. JSON-backed; identity verbatim.                                                                                                                                                                                                 |
| S4    | Notes + project memory + approval/evidence state | `projects` (Convex project aggregate), `projectRecords`, `notes`, `developmentEvents`, `developmentSubjects`, `runtimeEvents`, `toolActions`, `toolExecutionReceipts`, `memoryChangeSets`, `auditEvents`, `validationReports`, `externalReconciliations`, `omega*`. Convex-only. Receipt inertness rules from §2 apply here. |
| S5    | Orchestration + idempotency receipts             | orchestrationRuns/Steps/Reconciliations, directCreateReceipts, internalActionResults. Lease and indeterminate-state rules from §2 apply here.                                                                                                                                                                                |
| S6    | Quote aggregate + blobs                          | `quotes` (Convex aggregate), quoteRevisions, quoteDeliveryAttempts, quoteMigrationRecords, quotePdfArtifacts + Convex file storage. Physical-id translation and blob verification from §1/§3 apply here.                                                                                                                     |

Groups are built and tested incrementally. `completeness: complete` is only
reachable after S6 lands and its capture verifies, and only Jarvis decides
whether it is accepted.

## The verification gate

`src/backup/archiveManifest.ts` supplies the manifest parser, coverage metadata,
SHA-256 digest format checks and the full-recovery refusal gate. Group labels,
dependency strings and `consistentSnapshot` declarations are metadata, not
verification evidence, so coverage alone never earns `complete`.

What earns it is a completed restore. `verifyRestoredGroups` materialises the
archive into an isolated directory, re-reads every document with the strict
readers and again through the ordinary runtime stores, and returns a digest per
group **re-derived from what it read off disk**. `sealVerifiedArchive` records
those digests in `manifest.verification`, rebuilding the manifest through
`buildManifest` so `completeness` is re-derived rather than patched.
`parseManifest` then requires each recorded digest to equal that group's own
checksum, so evidence describing different bytes is rejected on the way back in.

`export-v4` runs that pass before it writes anything: an archive on disk has
always survived a real read-back. `assertRecoverable` reparses its input, so a
manifest that claims `complete` without the evidence to derive it is refused
rather than believed, and mutating `completeness` cannot bypass the gate.

The record is not proof against a determined forger — someone editing the file
by hand could copy the group checksums into it. It does not need to be. Forging
it buys nothing, because every restore re-runs the same verification and fails
loudly; what the record rules out is tooling that calls an archive recoverable
without ever having restored it.

The verification machinery is in place and runs on every capture and every
restore. What remains before `complete` is reachable is coverage: S4, S5 and S6
must capture `notesAndEvidence`, `orchestration` and `quoteAggregate`, including
physical-id translation and blob verification for the last of them. Once they
do, `deriveCompleteness` returns `complete` on its own — there is no separate
switch to throw. Existing v1–v3 backup commands remain unchanged.

## Relationship to the parked archive-v4 prototype

The original handoff describes a parked JSON-only prototype with empty-target
reservation, verbatim logical identity, strict readers, lock-held capture,
two-way verification and an isolated-restore completion marker. Its local
`stash@{0}` reference is not a durable review artifact. Those reported behaviors
must be verified against the actual S2–S3 candidate before reuse is accepted.

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

### S6 first mutable quote adapter (partial)

`convex/backupS6.ts:capture` performs one bounded owner-scoped read transaction,
requiring the existing service token and independent approval token. It captures
all five quote tables and the action, execution receipt and external reconciliation
inventories through the existing lossless v4 Convex codec. Limits are 100 rows per
table and 512 KiB encoded payload; overflow aborts, never truncates. The supplied
S3 business checksum binds the material to an archive payload; it does not prove
that a filesystem was read in the Convex transaction. No cross-provider atomic
snapshot is claimed.

The unregistered `restoreS6MutableQuotes` primitive supports only each aggregate's
first current `draft` or `reviewed` revision, with open commercial state, matching
versions and clocks, and no predecessor, finalized fingerprint or migration source.
It reuses the authoritative quote builder to validate normalized content and totals,
then inserts the exact logical documents into an entirely empty application database.
It preserves quote numbers and logical identities; only physical Convex IDs are
mapped. It never calls create, review, finalize, fork, migration, delivery or action
execution. Nonempty artifact, delivery, migration, action, receipt or reconciliation
inventories are refused, even when an unrelated record might eventually be safe.
Historical revisions and PDF regeneration are outside this slice.

The existing v4 Node layer's `prepareS6MutableRestore` first parses the same archive
and calls `verifyRestoredGroups` on its actual isolated destination. The canonical
strict business decoder and ordinary JSON stores must reproduce the archived digest;
missing client/project edges or any unresolved business reference abort. Callers may
not substitute an independent set of IDs. The Convex primitive alone proves only
logical closure against its supplied business payload, never physical S3 restoration.
It has no public mutation or CLI entrypoint.

`verifyRestoredS6MutableQuotes` repeats that filesystem proof, captures actual restored
Convex rows, checks table-scoped physical maps and exact documents, reads every quote
through `ConvexQuoteRepository.getQuote` and its bounded ordinary list, and derives
both digests from source and actual restored documents. It repeats S3 readback before
returning an explicitly partial subset report with no `ArchiveVerifiedGroup` entries.
The caller must keep both isolated destinations quiescent throughout preflight,
restore and verification; independent provider transactions do not prevent a concurrent
writer between reads. No manifest group is sealed, no full recovery is claimed, and
no finalized numbering, PDF, delivery or historical state is reconstructed by inference.

Composed S4/S6 validation requires the entire supplied S4 capture to satisfy its
closed restore subset. Capture can preserve a broader raw inventory; serialization
alone never establishes restorability. Unrelated audit producers, including Omega
events, remain explicitly unsupported and must make both S6 composition decoding
and the joint restore refuse before insertion. They are never ignored or removed
to make shared-action comparison pass. Broader evidence recovery remains work in
the same authoritative archive path.
