# Authoritative domain inventory (A2)

Every durable domain Jarvis owns, what backs it, and whether the backup archive
covers it today. This is the prerequisite for extending backup coverage: nothing
may be excluded silently, and any intentional exclusion needs a documented
recovery method plus Jarvis acceptance.

Inventory date: 2026-09-10. Base: `main` @ `612d596`.
Backup baseline: archive **v3** (`src/backup/backup.ts`).

**Authoritative** = this is the only copy; losing it loses user-entered fact or
evidence. **Derived** = reproducible from something else that is itself backed
up, under stated conditions.

## What archive v3 covers today

Eight sections: `state`, `tasks`, `reminders`, `builds`, `buildLogs`,
`upgrades`, `assets`, `preferences`. In JSON deployments that is six files
(`jarvis-state.json` carries state + tasks + reminders); in Convex deployments
it is the matching tables.

## 1. JSON-backed stores (`data/jarvis-*.json`)

| File                            | Domain                            | Authoritative | In v3   |
| ------------------------------- | --------------------------------- | ------------- | ------- |
| `jarvis-state.json`             | assistant state, tasks, reminders | yes           | **yes** |
| `jarvis-builds.json`            | builds                            | yes           | **yes** |
| `jarvis-build-logs.json`        | build log entries                 | yes           | **yes** |
| `jarvis-upgrades.json`          | upgrade chronicle                 | yes           | **yes** |
| `jarvis-assets.json`            | assets / maintenance              | yes           | **yes** |
| `jarvis-preferences.json`       | preferences                       | yes           | **yes** |
| `jarvis-clients.json`           | clients                           | yes           | no      |
| `jarvis-properties.json`        | properties                        | yes           | no      |
| `jarvis-projects.json`          | projects                          | yes           | no      |
| `jarvis-quotes.json`            | quotes                            | yes           | no      |
| `jarvis-invoices.json`          | invoices                          | yes           | no      |
| `jarvis-enquiries.json`         | enquiries                         | yes           | no      |
| `jarvis-errands.json`           | errands                           | yes           | no      |
| `jarvis-business-settings.json` | **business settings**             | yes           | no      |

**8 of 14 JSON files are uncovered.** Business settings has no Convex store at
all (`JsonBusinessSettingsStore` only), so the JSON file is its sole copy.

## 2. Convex tables

### Dual-provider (a JSON counterpart exists)

`assistantState`, `tasks`, `reminders`, `builds`, `buildLogs`, `upgrades`,
`assets`, `preferences` — covered by v3 through the provider-aware store bundle.

`projects`, `quotes` — Convex tables exist but model a **different** aggregate
than the JSON stores of the same name (`quotes` here is the revisioned quote
aggregate, not the flat JSON quote record). Not covered.

### Convex-only — none covered by v3

| Table                                                                                                              | Domain                                                                   | Authoritative?                          |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------- |
| `notes`                                                                                                            | **notes** — no JSON store exists; Convex is the only backing             | yes                                     |
| `quoteRevisions`                                                                                                   | quote revision content history                                           | yes                                     |
| `quoteDeliveryAttempts`                                                                                            | **delivery ledger** — evidence a quote was sent                          | yes                                     |
| `quotePdfArtifacts`                                                                                                | **artifact references** (storageId, digest, issuer, client, generatedAt) | yes                                     |
| `quoteMigrationRecords`                                                                                            | quote migration history                                                  | yes                                     |
| `toolActions`                                                                                                      | **approval state** for governed tool actions                             | yes                                     |
| `toolExecutionReceipts`                                                                                            | **execution evidence**                                                   | yes                                     |
| `memoryChangeSets`                                                                                                 | staged/approved memory changes                                           | yes                                     |
| `auditEvents`                                                                                                      | audit trail                                                              | yes                                     |
| `externalReconciliations`                                                                                          | provider reconciliation evidence                                         | yes                                     |
| `validationReports`                                                                                                | validation evidence                                                      | yes                                     |
| `omegaMissions`, `omegaActionContracts`, `omegaEvidence`, `omegaValidationProofs`, `omegaContradictionResolutions` | ΩΣ mission / evidence / proof state                                      | yes                                     |
| `orchestrationRuns`, `orchestrationSteps`, `orchestrationReconciliations`                                          | durable orchestration run state                                          | yes                                     |
| `directCreateReceipts`, `internalActionResults`                                                                    | idempotency receipts — replay protection                                 | yes (losing them re-admits a duplicate) |
| `developmentEvents`, `developmentSubjects`, `projectRecords`, `runtimeEvents`                                      | development / runtime event state                                        | yes                                     |

### 3. Convex file storage (blob store, outside all tables)

Quote PDF **bytes**, addressed by `quotePdfArtifacts.storageId`
(`ctx.storage.store` in `quoteFinalization.ts`). Not a table; not covered by any
archive; not reachable through the store interfaces backup uses today.

## The regenerability question, answered precisely

The earlier roadmap note called delivery ledger and PDF artifacts
"regenerable/re-derivable". That is **not** accurate as stated:

- **Delivery ledger (`quoteDeliveryAttempts`) is not regenerable at all.** It is
  evidence that a message was sent to a client at a time. Re-sending a quote
  produces a _new_ delivery, not a restoration of the old one. Treating it as
  regenerable would silently destroy the only record that a client was
  contacted.
- **PDF artifact bytes are conditionally regenerable.** `renderFinalizedQuotePdf`
  takes `generatedAt` as an input and embeds it in the PDF `/CreationDate`, so a
  re-render at a different time yields **different bytes and a different
  digest**. Byte-identical regeneration is possible only if all of these are
  preserved and fed back: the `quoteRevisions` snapshot, the artifact's stored
  `issuer` / `client` / `generatedAt`, and the _same_ `rendererVersion` code.
  A renderer change breaks digest reproduction permanently.

So excluding either on regenerability grounds requires, at minimum, backing up
`quoteRevisions` + `quotePdfArtifacts` metadata and pinning `rendererVersion` —
and even then the residual risk is that a future renderer change makes stored
digests unverifiable. That is a decision for Jarvis, not an assumption for
backup to make.

## Coverage gap summary

| Group                       | Count        | Status                                                                                                                                           |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| JSON files covered by v3    | 6            | covered                                                                                                                                          |
| JSON files uncovered        | 8            | **gap** (incl. business settings)                                                                                                                |
| Convex tables covered by v3 | 8            | covered                                                                                                                                          |
| Convex tables uncovered     | 27           | **gap** (incl. notes, delivery ledger, approval/evidence state, artifact references, ΩΣ evidence, orchestration run state, idempotency receipts) |
| Convex file storage         | 1 blob store | **gap**, and not reachable via any store interface                                                                                               |

## Open questions for Jarvis before coverage work proceeds

1. **Cross-domain ID mapping vs identity preservation.** A2 asks for "one
   consistent cross-domain ID mapping". A mapping is only required when the
   restore target may already hold conflicting ids. If restore targets a freshly
   reserved empty destination, preserving ids verbatim is both simpler and
   strictly safer (no reference rewriting, no chance of collapsing distinct
   records). Which restore model is intended decides this, and it should be
   decided before code is written.
2. **Idempotency receipts.** Restoring `directCreateReceipts` /
   `internalActionResults` preserves replay protection but also re-admits stale
   keys; not restoring them re-opens duplicate admission. Either is defensible;
   it needs a decision.
3. **Convex file storage.** Backing up PDF bytes needs a blob export path that
   does not exist. Options: add one, or accept metadata-only coverage with the
   conditional-regeneration recovery method above.
4. **Scope of a single archive.** 35 Convex tables plus 14 JSON files in one
   archive with one consistent contract is a large surface. Whether this lands
   as one archive version or staged by domain group is a scoping decision.

Nothing here is a completion claim. This inventory is evidence for A2 items 3
and 4 and is handed to Codex alongside them.
