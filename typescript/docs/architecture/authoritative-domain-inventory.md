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

| Table                                                                                                              | Domain                                                                                                                                                 | Authoritative?                          |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `notes`                                                                                                            | **notes** — no JSON store exists; Convex is the only backing                                                                                           | yes                                     |
| `quoteRevisions`                                                                                                   | quote revision content history                                                                                                                         | yes                                     |
| `quoteDeliveryAttempts`                                                                                            | **delivery ledger** — delivery-attempt and outcome evidence                                                                                            | yes                                     |
| `quotePdfArtifacts`                                                                                                | **artifact references** (storageId, digest, issuer, client, generatedAt)                                                                               | yes                                     |
| `quoteMigrationRecords`                                                                                            | quote migration history                                                                                                                                | yes                                     |
| `toolActions`                                                                                                      | **approval state** for governed tool actions                                                                                                           | yes                                     |
| `toolExecutionReceipts`                                                                                            | **execution evidence**                                                                                                                                 | yes                                     |
| `memoryChangeSets`                                                                                                 | staged/approved memory changes                                                                                                                         | yes                                     |
| `auditEvents`                                                                                                      | audit trail                                                                                                                                            | yes                                     |
| `externalReconciliations`                                                                                          | provider reconciliation evidence                                                                                                                       | yes                                     |
| `validationReports`                                                                                                | validation evidence                                                                                                                                    | yes                                     |
| `omegaMissions`, `omegaActionContracts`, `omegaEvidence`, `omegaValidationProofs`, `omegaContradictionResolutions` | ΩΣ mission / evidence / proof state                                                                                                                    | yes                                     |
| `orchestrationRuns`, `orchestrationSteps`, `orchestrationReconciliations`                                          | durable orchestration run state                                                                                                                        | yes                                     |
| `directCreateReceipts`, `internalActionResults`                                                                    | idempotency receipts — replay protection                                                                                                               | yes (losing them re-admits a duplicate) |
| `developmentEvents`, `developmentSubjects`, `runtimeEvents`                                                        | development / runtime event state                                                                                                                      | yes                                     |
| `projectRecords`                                                                                                   | **project memory** — components, facts, assumptions, constraints, measurements, decisions, risks, tasks and events; approved memory changes write here | yes                                     |

### 3. Convex file storage (blob store, outside all tables)

Quote PDF **bytes**, addressed by `quotePdfArtifacts.storageId`
(`ctx.storage.store` in `quoteFinalization.ts`). Not a table; not covered by any
archive; not reachable through the store interfaces backup uses today.

## The regenerability question, answered precisely

The earlier roadmap note called delivery ledger and PDF artifacts
"regenerable/re-derivable". That is **not** accurate as stated:

- **Delivery ledger (`quoteDeliveryAttempts`) is not regenerable.** It records
  pending, executing, succeeded, failed, indeterminate and reconciled attempts.
  A row proves only its recorded attempt/outcome; a pending or failed row is
  not proof that a client received a quote. Re-sending creates a new attempt,
  not a restoration of the original delivery history.
- **PDF artifact bytes are conditionally regenerable.** Preserve the complete
  render input: the Convex `quotes` aggregate (including its `number`), the
  `quoteRevisions` snapshot, the artifact's stored `issuer`, `client` and
  `generatedAt`, and the exact `rendererVersion` implementation. The renderer
  uses the aggregate number in the page header, PDF title and filename, and
  embeds `generatedAt` in `/CreationDate` (`src/quotes/quotePdfRenderer.ts`).
  A different timestamp or renderer can produce a different digest. A changed
  renderer does not make recovery impossible if the pinned original remains
  available, but regeneration must be verified against the stored digest.

Delivery history requires its own backup; revision/artifact metadata cannot
reconstruct it. Excluding PDF bytes requires all the inputs above, a preserved
renderer and an accepted, verified recovery procedure. Otherwise the bytes are
an authoritative coverage gap. The v4 contract includes blob export/import.

## Coverage gap summary

| Group                       | Count        | Status                                                                                                                                           |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| JSON files covered by v3    | 6            | covered                                                                                                                                          |
| JSON files uncovered        | 8            | **gap** (incl. business settings)                                                                                                                |
| Convex tables covered by v3 | 8            | covered                                                                                                                                          |
| Convex tables uncovered     | 27           | **gap** (incl. notes, delivery ledger, approval/evidence state, artifact references, ΩΣ evidence, orchestration run state, idempotency receipts) |
| Convex file storage         | 1 blob store | **gap**, and not reachable via any store interface                                                                                               |

## Decisions recorded after the inventory

The four questions raised by this inventory are resolved in
[the archive v4 contract](backup-v4-contract.md). That contract governs the
staged implementation:

1. Restore only into a freshly reserved empty destination. Preserve logical
   identity; explicitly translate platform-generated physical IDs wherever
   they occur, including string-typed references. Empty destinations do not
   make Convex `_id` values assignable, and existing JSON store `add()` APIs
   also generate IDs rather than accepting archived ones. The restore path
   must support preserved IDs explicitly instead of reusing those APIs blindly.
2. Restore receipts with their connected operation history and original scope,
   fingerprints and timestamps. Receipt restoration does not renew approval,
   reactivate leases or authorise another external effect.
3. Include blob export/import and digest verification. Exclusions need an
   accepted recovery method; metadata alone is not complete blob coverage.
4. Use one versioned manifest contract with staged domain groups, explicit
   coverage and partial-archive refusal on the full-recovery path.

Nothing here is a completion claim. This inventory is evidence for A2 items 3
and 4 and is handed to Codex alongside them.
