# Local V1 recovery gap analysis (LV1-09)

**Date:** 2026-10-07  
**Tracker:** #697  
**Slice:** LV1-09 recovery closure  
**Source read:** `adf82e37373105b2762033a22e8b1b9e8f7494c4` (`main`)  
**Plan:** `docs/operations/local-v1-release-plan.md`, `JARVIS_ROADMAP.yaml` `release_tracks.local-v1.workstreams.lv1-recovery`  
**Mode:** analysis, then PR 1, PR 2, PR 3, and PR 4. PR 1 locks the live split. PR 2 adds `captureLocalV1Archive`, a read-only partial capture. PR 3 restores that capture into a scratch JSON directory and an injected empty database. PR 4 adds `proveLocalV1Recovery`, which calls that restore and does not write a live store. It is not wired to `export-v4`. `completeness` stays `partial`.

## Decisions (integration lead, 2026-10-07)

These close section 7. They apply inside Local V1 scope.

1. LV1-11 evidence uses `convex-test` with an injected client. No new deployment. Never `CONVEX_URL`.
2. Convex notes and project-memory tables (`projects`, `projectRecords`, `notes`, `memoryChangeSets`) are **out** of the V1 set. They stay on the existing S4 slice.
3. ΩΣ, development history, and orchestration are **out** of the V1 set. Do not mark archive v4 `completeness: complete`.
4. The flat `jarvis-quotes.json` register is **in** the proof, alongside the Convex quote lifecycle.
5. `clear-local` must stop trusting a classic verify receipt. That is a later HARDEN step and must fail closed.
6. Gitignore for `typescript/data/jarvis-*.json*` is a separate change (PR #702). This slice does not touch `.gitignore`.
7. The proof fixture is a bounded synthetic set. Do not raise the S6 row or payload caps.

Required proof, unchanged:

`capture/export → validate → isolated restore → normal store/API reread → reference/artifact checks → runtime restart → rollback proof`

A partial archive is not that proof. Recovery must fail closed. A file on disk is not evidence.

## Verdict

LV1-09 is open. The repository already has two backup formats and three partial Convex adapters, and none of them covers the dataset the live Convex runtime actually uses.

On a `PERSISTENCE_PROVIDER=convex` process (the owner's dev deployment):

- Business records, errands, business settings, and the flat quote register are JSON files under the checkout that started the process: `<checkout>/typescript/data/jarvis-*.json`.
- Tasks, reminders, assistant state, builds, build logs, upgrades, assets, preferences, notes, and the quote lifecycle (revisions, PDF bytes, delivery, send receipts) are Convex tables plus Convex file storage.

`npm run backup -- export-v4` refuses that configuration, so the only command that reads the business JSON files will not run against the live provider. `npm run backup -- export` reads the Convex core and workshop stores and omits every business file and the quote lifecycle. Classic `verify` replays that archive into temporary JSON files, then writes a verify receipt. Classic `restore` writes into the live provider. Full-recovery restore of archive v4 refuses every archive `export-v4` can write, because `notesAndEvidence`, `orchestration`, and `quoteAggregate` are absent.

No current command produces capture, isolated restore, and a reread through the stores the HTTP API uses, for the whole Local V1 set, without touching live JSON or the live dev deployment.

## 1. Authoritative stores

`JARVIS_DATA_DIR` is `typescript/data` next to the source module that is executing (`typescript/src/persistence/jarvisDataPaths.ts`). Each JSON store defaults to the same directory from its own `import.meta.url`. A service started from a git worktree therefore keeps business JSON inside that worktree. Switching or deleting the worktree moves or drops those files. Convex rows stay on the dev deployment named by `CONVEX_URL`.

Selection is in `typescript/src/http/app.ts`. Business stores are constructed as JSON whenever the process uses the environment (about lines 265–294). They do not follow `PERSISTENCE_PROVIDER`. Memory stores do (`selectMemoryStore`, lines 189–198 and 295–324). Core persistence follows `createPersistenceFromEnv()` (`typescript/src/persistence/providerSelection.ts`).

### 1.1 JSON files that stay authoritative under Convex

All of these are `{ version: 1, <collection> }` except where noted. Writers use `writePrivateJsonFile` and `JsonFileLock`. Default path is `<checkout>/typescript/data/<file>`.

| File                            | Writer                                               | Document shape                                                                 | What Local V1 uses it for                                                                                                       |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `jarvis-clients.json`           | `JsonClientStore` (`src/clients/jsonClientStore.ts`) | `{ version, clients[] }`                                                       | Clients. `remove` deletes the client only.                                                                                      |
| `jarvis-properties.json`        | `JsonPropertyStore`                                  | `{ version, properties[] }` with `clientId`                                    | Properties.                                                                                                                     |
| `jarvis-projects.json`          | `JsonProjectStore`                                   | `{ version, projects[] }` with `clientId`, `propertyId`                        | Business jobs. Not the Convex `projects` table.                                                                                 |
| `jarvis-enquiries.json`         | `JsonEnquiryStore`                                   | `{ version, enquiries[] }` with `clientId`, `propertyId`, `convertedProjectId` | Enquiries. No HTTP delete route.                                                                                                |
| `jarvis-invoices.json`          | `JsonInvoiceStore`                                   | `{ version, invoices[] }` with `clientId`, `projectId`, optional `quoteId`     | Invoice drafts. No HTTP delete route.                                                                                           |
| `jarvis-errands.json`           | `JsonErrandStore`                                    | `{ version, errands[] }` with optional `projectId`                             | Errands.                                                                                                                        |
| `jarvis-business-settings.json` | `JsonBusinessSettingsStore`                          | `{ version, settings }` single object (contact, payment, pricing, numbering)   | Issuer and numbering inputs for quotes and invoices.                                                                            |
| `jarvis-quotes.json`            | `JsonQuoteStore`                                     | `{ version, quotes[] }` with `clientId`, optional `projectId`                  | Flat quote register used by the daily brief and the `quotes:create` / `quotes:list` / `quotes:show` CLI. Not the lifecycle API. |

`jarvis-operator-audit.jsonl` (`settings/dangerZone`) is an append-only local audit of danger-zone actions. It is not a business store and is not in either backup format.

`.gitignore` on this baseline ignores `typescript/data/jarvis-state.json*` and the Temporal preview files. It does not ignore the business files above, so `git status` can show them as untracked. That matches the LV1-01 note on #697. The ignore change is PR #702 and is not part of this slice.

### 1.2 JSON files that are not the live store when the provider is Convex

These files still exist as the JSON implementation, and archive v4 reads them when the provider is `json`. With `PERSISTENCE_PROVIDER=convex` the HTTP app does not write them.

| File                      | JSON writer                                                                                                          | Live writer when provider is Convex                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `jarvis-state.json`       | `JSONPersistence` (`src/persistence/jsonPersistence.ts`), document version 2: `{ version, state, tasks, reminders }` | `ConvexPersistence` → tables `tasks`, `reminders`, `assistantState` |
| `jarvis-builds.json`      | `JsonBuildStore`                                                                                                     | `ConvexBuildStore` → `builds`                                       |
| `jarvis-build-logs.json`  | `JsonBuildLogStore`                                                                                                  | `ConvexBuildLogStore` → `buildLogs`                                 |
| `jarvis-upgrades.json`    | `JsonUpgradeStore`                                                                                                   | `ConvexUpgradeStore` → `upgrades`                                   |
| `jarvis-assets.json`      | `JsonAssetStore`                                                                                                     | `ConvexAssetStore` → `assets`                                       |
| `jarvis-preferences.json` | `JsonPreferenceStore`                                                                                                | `ConvexPreferenceStore` → `preferences`                             |

A capture that reads these files while the live process is on Convex records an empty or stale checkout, not the workshop and home data.

Public ids for Convex tasks, reminders, builds, build logs, upgrades, assets, and preferences are the Convex document `_id` (`taskFromConvex`, `buildFromConvex`, and the matching stores). `buildLogs.buildId` and `upgrades.buildId` are that builds `_id`; `convex/buildOwnership.ts` resolves them with `normalizeId("builds", ...)`. They are physical ids. Restoring them into a new Convex database requires a table-scoped id map. Replaying them into a JSON file does not prove that.

### 1.3 Convex tables the Local V1 runtime uses

Schema is `typescript/convex/schema.ts` (`schemaBase.ts` plus `omegaSchema.ts` plus `developmentSchema.ts`).

**Home and assistant (provider = convex)**

| Table                   | Role                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `tasks`                 | Tasks. Public id is `_id`.                                                                                                  |
| `reminders`             | Reminders, including normalized due fields. Public id is `_id`.                                                             |
| `assistantState`        | Assistant state document. Nested task and reminder ids are physical ids.                                                    |
| `directCreateReceipts`  | Idempotency receipts for task and reminder creates. `entityId` is a physical id (`convex/tasks.ts`, `convex/reminders.ts`). |
| `internalActionResults` | Same entity id in `entityId` and nested `result.id`.                                                                        |

**Workshop (provider = convex)**

| Table         | Role                                                  |
| ------------- | ----------------------------------------------------- |
| `builds`      | Assets' sibling: workshop builds. Public id is `_id`. |
| `buildLogs`   | Build log entries. `buildId` is a builds `_id`.       |
| `upgrades`    | Upgrade records. `buildId` is a builds `_id`.         |
| `assets`      | Assets. Public id is `_id`.                           |
| `preferences` | Preference rows. Public id is `_id`.                  |

**Quote lifecycle (Convex only; JSON provider returns 503)**

`createQuoteRepositoryFromEnv` (`src/quotes/quoteRepositoryFactory.ts`) returns `ConvexQuoteRepository` only when the provider is `convex`. `QuoteController` (`/api/v1/quotes`) uses that repository. There is no JSON port.

| Table                   | Role                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `quotes`                | Aggregate. Logical `quoteId`. `clientId` and optional `projectId` are strings, not Convex ids.                   |
| `quoteRevisions`        | Draft, review, finalize, historical revisions. Logical `revisionId`.                                             |
| `quotePdfArtifacts`     | PDF metadata. `storageId` is `v.id("_storage")`. Digest, renderer `quote-pdf:v1`, issuer, client, `generatedAt`. |
| `quoteDeliveryAttempts` | Governed send ledger (status, provider ids, reconciliation id).                                                  |
| `quoteMigrationRecords` | Legacy migration sources, if any rows exist.                                                                     |

PDF bytes are not in the table. `convex/quoteFinalization.ts` `finalizeRevision` renders the PDF and calls `ctx.storage.store`. The bytes live in Convex `_storage`. The contract in `typescript/docs/architecture/backup-v4-contract.md` says those bytes are in scope: a re-render changes `/CreationDate` because `generatedAt` is embedded, so the PDF is not regenerable for digest equality.

**Send, approval, receipts (Convex only)**

Wired when the environment is present (`app.ts`): `createToolActionServiceFromEnv`, `createToolExecutionServiceFromEnv`, `ConvexExternalReconciliationStore`.

| Table                     | Role for V1                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `toolActions`             | Approvals for quote send and other governed tools. Restoring one must not refresh expiry or re-authorise execution. |
| `toolExecutionReceipts`   | Execution receipts. Restoring one must not become a new replay hit that sends mail.                                 |
| `externalReconciliations` | Outlook and other external reconciliation rows tied to delivery.                                                    |

**Notes**

`noteStore` is `ConvexNoteStore` whenever the process has an environment, including when the provider is `json` (`app.ts` lines 325–330). Notes have no JSON file. Workshop "maintenance" in the release plan is builds, logs, upgrades, and maintenance information. The code path that stores maintenance text on a build is the build, upgrade, and build-log rows above. Convex `notes` are project-memory notes (`notes.create`), not the business job file.

### 1.4 Convex tables that are not the Local V1 daily-driver dataset

These are real tables. They are not what LV1-06/07/08 read and write for the business, home, and workshop daily paths. Archive v4 still lists their groups as required for `completeness: complete`. That contract gate and the Local V1 dataset are not the same set.

| Tables                                                                                                             | Why they are out of the V1 daily set                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `projects`, `projectRecords`                                                                                       | Governed project-memory aggregate (project key, components, risks). A different namespace from `jarvis-projects.json`. |
| `notes`, `memoryChangeSets`                                                                                        | Project-memory notes and approved memory edits.                                                                        |
| `developmentSubjects`, `developmentEvents`, `developmentEvidence`                                                  | Governed development mission history.                                                                                  |
| `omegaMissions`, `omegaActionContracts`, `omegaEvidence`, `omegaValidationProofs`, `omegaContradictionResolutions` | ΩΣ completion authority. Restore must not mint completion.                                                             |
| `orchestrationRuns`, `orchestrationSteps`, `orchestrationReconciliations`                                          | Durable orchestration. Live commissioning is #324, explicitly non-blocking for Local V1.                               |
| `auditEvents`, `validationReports`, `runtimeEvents`                                                                | Operator and runtime evidence streams.                                                                                 |

### 1.5 Other configuration that is not a data store

| Item                                                              | Where it lives                                                                         | Recovery implication                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `JARVIS_TIMEZONE`                                                 | Process env (`src/http/config.ts`)                                                     | Brief and reminder display. Not in an archive.                                     |
| `JARVIS_GOOGLE_HOME_TARGETS_JSON`, `JARVIS_GOOGLE_HOME_TTS_VOICE` | Process env (`googleHomeAnnouncementProvider.ts`)                                      | Pinned announcement targets. Not in an archive. Do not copy secrets into a backup. |
| Service, approval, and delivery tokens                            | Env / Convex env                                                                       | Not data. Archives must not contain them.                                          |
| Console display preferences                                       | Operator console, deliberately not `jarvis-preferences` (`typescript/docs/ROADMAP.md`) | Not a V1 store.                                                                    |

### 1.6 Two quote stores, two project stores

Local V1 quote draft, edit, finalise, PDF, and send use `ConvexQuoteRepository` and `convex/quoteFinalization.ts`. The daily brief (`briefController`) and the quote CLI use `JsonQuoteStore` and `jarvis-quotes.json`. HUD quote register uses the Convex repository (`hudSnapshot.ts`). An archive of `jarvis-quotes.json` does not restore the lifecycle. A Convex quote capture does not restore the flat file the brief reads.

Business jobs are `jarvis-projects.json`. Convex `projects` / `projectRecords` are the project-memory aggregate. Recovery must not load one into the other.

Cross-store edges that matter for V1:

- Convex `quotes.clientId` → JSON `clients[].id`
- Convex `quotes.projectId` → JSON `projects[].id` (business project)
- JSON `invoices[].quoteId` is an opaque string (`src/invoices/invoice.ts`). Callers can store either a flat JSON quote id or a Convex `quoteId`. The checker has to resolve both namespaces.
- JSON-to-JSON edges already listed in `src/backup/crossDomainReferences.ts`: property→client, project→client/property, flat quote→client/project, invoice→client/project/quote, enquiry→client/property/converted project, errand→project.
- Convex `quotePdfArtifacts.storageId` → `_storage` bytes.
- Convex `quoteDeliveryAttempts` → quote revision fingerprint, and `reconciliationId` → `externalReconciliations`.
- `toolActions` / receipts that carry the quote send → the same quote and delivery rows.
- `buildLogs.buildId` / `upgrades.buildId` → `builds._id` after physical-id translation.
- `directCreateReceipts.entityId` and `internalActionResults` → restored task or reminder `_id`.

## 2. Existing backup tooling

### 2.1 Classic archive v1–v3 — `src/backup/backup.ts`, `src/tools/runBackup.ts`

Commands: `npm run backup -- export|verify|restore`. Current version is 3. Format `jarvis-backup`. 10 MiB cap.

| Step     | What it does                                                                                                                                                                                                                        | What it misses                                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Export   | `provider.snapshot()` plus the memory stores for the active provider. On Convex that is tasks, reminders, assistant state, builds, build logs, upgrades, assets, preferences. Private file mode `0600`. Refuses an existing target. | Clients, properties, business projects, enquiries, invoices, errands, business settings, both quote stores, PDF bytes, delivery rows, tool actions, receipts, reconciliations, notes, idempotency receipts. The CLI text says so.                                      |
| Validate | `parseBackup` checks shape, ids, and build-log/upgrade `buildId`s inside the archive.                                                                                                                                               | No business references. No proof the build id is a Convex id that can be remapped.                                                                                                                                                                                     |
| Verify   | Restores into `os.tmpdir()` using `JSONPersistence` and the JSON memory stores, then deletes the directory. Writes `<file>.jarvis-verify.json` via `writeBackupVerifyReceipt`.                                                      | The reread is JSON, even when the export came from Convex. It never calls `ConvexBuildStore`, `ConvexPersistence`, or the HTTP API. It does not restore PDF bytes. The receipt is what Danger zone accepts as a recent backup.                                         |
| Restore  | `restoreBackupIntoEmptyProvider(createPersistenceFromEnv(), archive, createMemoryStoresFromEnv())`. Requires `--confirm-empty-target`. Refuses a non-empty target.                                                                  | The target is the live provider. On the owner's machine that is the live dev deployment. It does not restore business JSON or the quote lifecycle. Task and build public ids are Convex `_id`s; a JSON verify does not show whether a Convex insert can preserve them. |

Tests: `typescript/tests/backup.test.ts`. Isolated temp JSON only.

### 2.2 Archive v4 JSON groups — `src/backup/v4/`, `src/tools/runBackupV4.ts`

Commands: `export-v4`, `verify-v4`, `restore-v4`. Contract: `typescript/docs/architecture/backup-v4-contract.md`. Operator page: `typescript/docs/operators/archive-v4.md` and `persistence-settings.md`.

Groups required for `completeness: complete` (`src/backup/archiveManifest.ts`): `core`, `memory`, `businessRecords`, `notesAndEvidence`, `orchestration`, `quoteAggregate`.

`export-v4` calls `resolveJsonSourceConfig()`. If the provider is not `json`, it throws and writes nothing (`src/backup/v4/jsonSource.ts`). Settings → Persistence shows that refusal and labels v4 "Partial / JSON-only".

When the provider is `json`, one lock-held read captures:

- `core` from `jarvis-state.json`
- `memory` from the five JSON workshop/preference files
- `businessRecords` from the eight business files, including the flat quote register and business settings

Strict readers abort on malformed JSON, unknown fields, duplicate ids, and symlinks. Ordinary stores must agree with the strict read (totals recomputed). Unresolved JSON references are recorded, not repaired. `export-v4` then restores into a throwaway directory, rereads through the strict readers and the JSON stores, and seals those digests into `manifest.verification`. Coverage stays `partial` because three groups are absent. `assertRecoverable` refuses `complete` without that evidence, and refuses a partial archive on the full-recovery path.

`restore-v4` creates an empty directory, refuses overlap with `JARVIS_DATA_DIR`, writes an in-progress marker, and removes it only after verification. `--resume` continues the same archive fingerprint. `--allow-partial` is required today and is explicitly not a recovery. No Convex client is opened. Blob index on the manifest exists (`archiveManifest.ts`) and is empty for these exports.

`npm run restore-drill` (`src/tools/runRestoreDrill.ts`) replays interrupted JSON restore in a scratch directory with a synthetic dataset. It never reads live data. It does not include Convex, PDFs, or the HTTP API.

Tests: `tests/backupV4Groups.test.ts`, `tests/backupV4Business.test.ts`, `tests/backupV4RecoverableRestore.test.ts`, `tests/backupV4Limits.test.ts`.

### 2.3 Convex slice adapters (S4, S5, S6)

These are library and `convex-test` primitives. They are not `export-v4`. They do not set a manifest group to present. They have no CLI entry. `completeness` stays `partial`.

| Adapter                                                     | Capture                                                                                                                                                                                                                                                                                                        | Restore that exists                                                                                                                                                                                                                                                                                                                                                                                        | Blocker for LV1-09                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S4 `convex/backupS4.ts`, `src/backup/v4/s4ProjectNotes.ts`  | Owner-scoped read of project-memory, development, runtime, tool, audit, and omega tables. Caps: 1000 rows/table, 2000 total, payload bound. Needs service token and a separate approval token.                                                                                                                 | Unregistered `restoreS4ProjectNotes`. Empty database only. Admits a closed subset: projects, notes, four-kind memory history, never-approved rejected `notes.create`, empty-attribute components, canonical risks, and the matching blocked denial receipt. Refuses non-empty attributes, primary-key effect receipts, reconciliations, development bindings, and omega rows.                              | Not the business/workshop/quote set. Does not seal `notesAndEvidence`. Must not be weakened to drop omega rows so a comparison passes.                       |
| S5 `convex/backupS5.ts`                                     | `orchestrationRuns`, `orchestrationSteps`, `orchestrationReconciliations` only. 100/table, 300 total, 512 KiB. Raw capture of queued or leased rows is not restorable.                                                                                                                                         | Unregistered `restoreS5TerminalOrchestration`. Empty database. Terminal runs only. Leases not reinstated.                                                                                                                                                                                                                                                                                                  | #324 is post-V1. `directCreateReceipts` and `internalActionResults` are outside this primitive. Does not seal `orchestration`.                               |
| S6 `convex/backupS6.ts`, `src/backup/v4/s6MutableQuotes.ts` | `quotes`, `quoteRevisions`, `quotePdfArtifacts`, `quoteDeliveryAttempts`, `quoteMigrationRecords`, `toolActions`, `toolExecutionReceipts`, `externalReconciliations`. 100 rows/table, 512 KiB. Bound to an S3 business checksum. The checksum does not prove the JSON files were read in the same transaction. | Unregistered `restoreS6MutableQuotes`. Empty database. First `draft` or `reviewed` revision only, open commercial state, no predecessor, no finalized fingerprint, no migration source. Refuses non-empty artifact, delivery, migration, action, receipt, or reconciliation inventories. `verifyRestoredS6MutableQuotes` rereads via `ConvexQuoteRepository.getQuote` and returns `completeness: partial`. | Finalised quotes, PDF bytes, delivery, and send receipts are the V1 path, and this restore refuses them. No blob export. No CLI. No sealed `quoteAggregate`. |

Tests: `convex/backupS4*.test.ts`, `convex/backupS5*.test.ts`, `convex/backupS6.test.ts`, `convex/backupComposition.test.ts`. In-process `convex-test`. They do not open the live dev deployment.

### 2.4 Danger zone and settings

`clear-local` quarantines every basename in `coreDataFiles` and `businessDataFiles` (`.corrupt-*` rename, not unlink). It does not call Convex deletes. Skip still requires accepting irreversible loss. A verified backup authorises the quarantine only when its receipt lists sha256 or `absent` for every business JSON file and those checksums match the live files. A classic verify receipt does not.

`reset-local-json` quarantines only `jarvis-state.json`. Under Convex that file is not the live task store.

Persistence settings wrap the commands above. They do not add a third backup path. There is no restore into an empty Convex deployment in the CLI.

## 3. Coverage matrix

Rows are the authoritative Local V1 stores on a Convex dev runtime. Columns are the required proof. "Partial" means some adjacent code exists and is not this proof.

| Store                                                                                        | Capture                                                                                                               | Validate                                                 | Isolated restore                                                       | Store/API reread                        | Reference / artifact check                                                                           |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| JSON clients, properties, business projects, enquiries, invoices, errands, business settings | v4 business group only, and only if provider is `json`. Refused on the live Convex process.                           | v4 strict reader                                         | v4 empty directory, `--allow-partial` only                             | JSON stores, not HTTP                   | JSON edges only. Recorded if dangling. Not checked against Convex quotes.                            |
| JSON flat quotes                                                                             | Same as business group                                                                                                | v4 strict reader                                         | Same                                                                   | `JsonQuoteStore`                        | Not the lifecycle.                                                                                   |
| Tasks, reminders, assistant state                                                            | Classic export via Convex. v4 would read the unused JSON file, and refuses because provider is Convex.                | Classic parse                                            | Classic verify → temp JSON. Classic restore → live Convex.             | JSON on verify. Live Convex on restore. | Nested state ids remapped only on the minting restore path. Not proven on an isolated Convex target. |
| `directCreateReceipts`, `internalActionResults`                                              | None                                                                                                                  | None                                                     | None                                                                   | None                                    | Contract names the physical ids. S5 does not capture them.                                           |
| Builds, logs, upgrades, assets, preferences                                                  | Classic export via Convex                                                                                             | Classic parse checks log/upgrade build ids as strings    | Same split as tasks: temp JSON vs live Convex                          | Same                                    | JSON verify cannot show Convex `_id` translation.                                                    |
| Convex quote aggregate and revisions                                                         | S6 capture query only. Not in an archive file.                                                                        | S6 decoder. Restore admits only the first open revision. | Unregistered helper, empty `convex-test` database, draft/reviewed only | `getQuote` in the S6 verifier           | `clientId` checked only against a supplied business payload, not a restored JSON directory.          |
| PDF metadata and `_storage` bytes                                                            | Metadata can sit in an S6 capture. Bytes are not exported.                                                            | Restore refuses non-empty artifacts.                     | None                                                                   | None                                    | Digest check against restored bytes does not exist.                                                  |
| Delivery attempts, migration records                                                         | S6 capture. Restore refuses non-empty inventories.                                                                    | Fail-closed refusal                                      | None for real rows                                                     | None                                    | None                                                                                                 |
| Tool actions, receipts, reconciliations                                                      | S4 and S6 capture inventories. S6 restore refuses non-empty inventories. S4 restore admits one narrow denial receipt. | Refusal, not round-trip                                  | None for quote-send history                                            | None                                    | Inertness rules exist for the narrow S4 receipt only.                                                |
| Convex notes / project memory                                                                | S4 capture. Not a sealed group.                                                                                       | Closed subset only                                       | `convex-test`, empty db                                                | Partial                                 | Not a V1 business file.                                                                              |
| Orchestration history                                                                        | S5 capture                                                                                                            | Terminal subset only                                     | `convex-test`                                                          | `getRun` / `listSteps`                  | Post-V1.                                                                                             |
| Restart of a restored process                                                                | None                                                                                                                  | None                                                     | None                                                                   | None                                    | None                                                                                                 |
| Rollback (live data unchanged, failed restore not live)                                      | v4 JSON destination has an in-progress marker.                                                                        | Proven for JSON drill only.                              | No Convex equivalent wired to a command.                               | None                                    | None                                                                                                 |

`completeness: complete` is unreachable. That is correct. It is not Local V1 evidence either: a partial archive cannot be promoted by ignoring the missing groups.

## 4. Gaps that block LV1-09

1. **No single capture of the live split.** Business JSON and Convex home/workshop/quote data are never in one archive. The command that reads business JSON refuses the provider that the live service uses.
2. **No isolated Convex restore.** Classic restore targets `createPersistenceFromEnv()`. S4/S5/S6 restores are unregistered and subset-only.
3. **Verify does not reread through the live store types.** Classic verify uses JSON stores. v4 verify uses JSON stores. S6's repository reread does not include finalised quotes, PDFs, or HTTP.
4. **Quote lifecycle recovery refuses the V1 states.** Finalised revisions, PDF bytes, delivery rows, and send receipts are captured only as an S6 inventory that restore will not apply.
5. **PDF bytes have no export.** `_storage` is the artifact body. The manifest blob list is unused.
6. **Cross-store edges are unchecked.** Convex `quotes.clientId` / `projectId` point at JSON ids. v4 reference checks stay inside the JSON group. Invoice `quoteId` is not tied to the lifecycle id.
7. **Physical ids are not translated on a path that then rereads Convex.** Task, reminder, build, log, and upgrade ids are `_id`s. A JSON replay hides that.
8. **Idempotency receipts for tasks and reminders are not in any capture.** Restoring tasks without `directCreateReceipts` / `internalActionResults` can re-admit a duplicate create. Restoring them badly can replay a side effect. The v4 contract already forbids both outcomes.
9. **Full recovery correctly fail-closes, and nothing else is allowed to count.** `--allow-partial`, a classic file, or an S6 partial report is not the LV1-09 proof.
10. **No restart proof and no rollback proof** for a restored HTTP process against isolated JSON and an isolated Convex target.
11. **Danger-zone clear can destroy business JSON after a backup that does not contain it.** The receipt gate is classic verify.

## 5. Smallest PR sequence

Reuse the archive v4 manifest, the JSON business readers, classic provider snapshot, the S6 capture query, `ConvexQuoteRepository`, and `convex-test`. Do not add a second database, a second evidence store, or a parallel business file format. Do not set `completeness: complete` while `notesAndEvidence`, `orchestration`, or `quoteAggregate` are absent. Do not weaken `assertRecoverable`, approval checks, or receipt inertness.

Isolated restore for every PR below:

- **JSON.** A new empty directory from `mkdtemp`. Pass that directory's file paths into the existing store constructors. `restore-v4` already refuses a destination that overlaps `JARVIS_DATA_DIR`. Do not pass the live data directory. Do not run the live service against the scratch directory.
- **Convex.** `convex-test` with an empty in-memory database, which is what S4/S5/S6 already use. The harness must not construct `ConvexHttpClient` from `process.env.CONVEX_URL`. A test double or an explicit client argument is the existing pattern (`ConvexBuildStore` and `ConvexPersistence` already accept a client). No `npx convex deploy`, no `npx convex dev` against the owner's deployment, no mutation against the live URL.
- **Cross-store check.** After both restores, load the isolated JSON stores and the isolated Convex repository. For each restored Convex quote, `clientId` must be found in the isolated client store. If `projectId` is set, it must be found in the isolated business-project store. If an invoice `quoteId` is set, it must match either an isolated flat quote id or a restored Convex `quoteId`; otherwise fail. PDF `storageId` must be the new `_storage` id, and the stored bytes' digest must equal the artifact digest. Build-log and upgrade `buildId`s must be the new builds ids. Delivery `reconciliationId` must match a restored reconciliation row. Unresolved edges that were already in the source are allowed only when the capture manifest lists them and the restored list is identical. The restore must not add new dangling edges. Do not run `UuidRemapper` over JSON business ids; v4 already preserves those. Do run table-scoped physical-id maps for Convex `_id` and `storageId`.

### PR 1 — REUSE: lock the live split in a test

Done in `typescript/tests/localV1PersistenceSplit.test.ts`. With `PERSISTENCE_PROVIDER=convex` and a non-routable `CONVEX_URL`, the HTTP app's own stores are:

- business, errand, business-settings, and the flat quote register: the JSON classes;
- task/reminder persistence, builds, build logs, upgrades, assets, preferences, and the quote repository: the Convex classes.

`export-v4` (`exportArchiveV4File`) throws `StrictBackupError` and writes no file. `assertRecoverable` rejects a manifest whose only absent group is `quoteAggregate`. A classic `exportBackup` archive has no `clients` or `invoices` field. No production behaviour change. This stops a later patch from calling a classic file or a partial v4 file a recovery.

### PR 2 — EXTEND: one partial capture of the live split

Landed as `captureLocalV1Archive` in `typescript/src/backup/v4/localV1Capture.ts`. It is a sibling of `export-v4`, not a change to that command. `export-v4` still refuses `PERSISTENCE_PROVIDER=convex`. JSON-provider archive export is unchanged. The function takes an injected Convex client and never constructs one from `CONVEX_URL`.

A successful run creates one new directory and writes only inside it:

| Live store                                                                                                                                            | Captured as                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Business JSON: clients, properties, projects, flat quotes, invoices, enquiries, errands, settings                                                     | `readBusinessGroup` into archive group `businessRecords`                                                                 |
| Tasks, reminders, assistant state                                                                                                                     | `exportBackup` / `ConvexPersistence.snapshot` into group `core`                                                          |
| Builds, build logs, upgrades, assets, preferences                                                                                                     | `exportBackup` Convex list stores into group `memory`                                                                    |
| S6 tables: quotes, quote revisions, PDF artifact rows, deliveries, migration records, tool actions, tool execution receipts, external reconciliations | `backupS6:captureLocalV1` sidecar `convex-s6.json`. `S6_TABLES` is unchanged                                             |
| `directCreateReceipts`, `internalActionResults`                                                                                                       | Same query, sibling payload `convex-receipts.json`, same 100-row and 512 KiB abort                                       |
| `_storage` PDF bytes                                                                                                                                  | Read-only action `backupS6:readLocalV1Blobs`; raw bytes under `blobs/<sha256 hex>` plus the existing manifest blob entry |
| Notes, project memory, orchestration, `quoteAggregate`                                                                                                | Absent. `completeness` stays `partial`. `consistentSnapshot` is false                                                    |

Capture refuses a URL equal to `CONVEX_URL` (or another forbidden URL) and refuses an output path that already exists or overlaps a live data directory. Reads finish before the output directory is created. Convex `mutation` calls throw. A missing table, missing PDF bytes, corrupt business JSON, or a failed query/action throws and leaves no output directory. Overflow still aborts; it does not truncate. Tokens stay out of the files. This is not isolated restore. `assertRecoverable` still refuses the archive.

### PR 3 — EXTEND: isolated restore of that capture

Landed as `restoreLocalV1Archive` in `typescript/src/backup/v4/localV1Restore.ts`. JSON business, core, and memory documents go through `restoreArchiveV4` with `allowPartial: true` into a directory that must not already exist and must not overlap the live data directory or the capture directory. Convex rows go through action `backupLocalV1Restore:restoreLocalV1` and internal mutation `insertIsolated`. The caller supplies an empty `convex-test` client. The function never constructs a client and refuses a target identity equal to `CONVEX_URL`.

`restoreS6MutableQuotes` and `readS6MutableQuotes` are unchanged. A captured sidecar that contains a finalized revision or a nonempty delivery still throws from the draft-only helper.

The new apply path, and only that path:

- preserves logical `quoteId` / `revisionId`, including a finalized current revision and the historical draft that preceded it;
- stores PDF bytes, checks the digest of the bytes just stored, and writes the new `storageId`;
- copies delivery, migration, tool-action, receipt, and reconciliation rows verbatim, with no lease and no call to `approve` or send;
- refuses an approved tool action whose expiry policy is not `ttl` or whose `approvalExpiresAt` is still in the future, so a restored approval is not executable and its expiry is not refreshed;
- refuses a reconciliation that is not `resolved` with terminal status `succeeded` or `failed`, and refuses one whose receipt is missing or whose effect fingerprint differs, so a restored receipt is not a `no-effect` replay that sends mail;
- inserts tasks, reminders, assistant state, builds, logs, upgrades, assets, and preferences directly, and returns id maps for tasks, reminders, and builds. Build logs and upgrades take the new build id. Direct-create receipts and internal action results, including `result.id`, take the new task or reminder id. Assistant-state strings that are exactly a mapped id are rewritten;
- fails before any write when a sidecar checksum, table, quote link, invoice quote, or PDF digest does not match, and deletes the scratch directory plus any blobs it stored when the empty-database apply throws.

Reread is through `JsonClientStore`, `JsonQuoteStore`, `JsonInvoiceStore`, `ConvexPersistence`, `ConvexBuildStore`, `ConvexAssetStore`, and `ConvexQuoteRepository.getQuote` / `listQuotes`. The archive stays `partial`. `assertRecoverable` still refuses it.

### PR 4 — HARDEN: the Local V1 proof gate

Landed as `proveLocalV1Recovery` in `typescript/src/backup/v4/localV1Proof.ts`. It calls `restoreLocalV1Archive` and does not add a second apply path. `clear-local` refuses a classic verify receipt that omits core, memory, or business checksums. The explicit skip remains. `completeness` stays `partial`. Operator text names that gate in `archive-v4.md` and `persistence-settings.md`.

The proof criteria are unchanged. They still require a restarted process before the GET results are matched:

`capture/export → validate → isolated restore → normal store/API reread → reference/artifact checks → runtime restart → rollback proof`

Runtime restart means a restarted process serves `GET` for a client, a task, a build, and a quote, and those results match the read taken before the restart. Quote GET across a real restarted `src/http/main.ts` is **PROVEN** on host at main `2d34a741` with an isolated self-hosted convex-local-backend on `127.0.0.1` (never the shared dev deployment). Evidence: host `~/lv1-01/restart-proof.md`, quote body sha256 `c7fd9977…dbb8`. That host run needed workarounds for the snapshot validator, orphan direct-create receipts, and dropped build fields. A host re-proof of `990bd8c2` passed capture, restore, field fidelity, quote sha256 equality, and tombstoned replay refusal, and the restart step failed because the isolated child was not given `JARVIS_DELIVERY_RUNTIME_TOKEN`. The harness now passes that token. Full end-to-end recovery on realistic data stays **NOT YET MET** until the host repeats that restart step. `completeness` stays `partial`. Recovery is not complete.

Off-host, these parts are met:

- `proveLocalV1Recovery` requires `liveDirectory` to be the same resolved path as `restore.liveDataDir`. When `liveDataDir` is omitted, that path is the checkout data directory. A mismatch throws before restore and writes nothing.
- `readRestartedProcess` spawns the existing `src/http/main.ts` entrypoint as a child Node process with `JARVIS_DATA_DIR` set to a scratch JSON directory. The default is JSON-only: it GETs a client, a task, and a build, kills the process, spawns `src/http/main.ts` again, and requires those three bodies to match. `quoteRecovered` stays false. The live data directory digest is unchanged. The child `CONVEX_URL` is `http://127.0.0.1:9`, which is not the configured deployment URL. The same harness can be pointed at an isolated Convex URL. That mode passes the caller-supplied `JARVIS_DELIVERY_RUNTIME_TOKEN` to the child. It refuses the configured `CONVEX_URL`, including a localhost / `127.0.0.1` / `::1` alias on the same port, and any `*.convex.cloud` or `*.convex.site` host, then GETs and compares the quote as well. The existing entrypoint still constructs a notes client from that process variable; the proof does not call notes and does not pass the configured URL. A node test does the JSON default on JSON written by the existing stores. The convex-test restore test does it again on the JSON directory `proveLocalV1Recovery` just wrote.
- `clear-local` checksums cover every core, memory, and business file that action quarantines. A receipt that lists only the business files does not authorise the quarantine.

The off-host default still has no dialable Convex backend: the quote lifecycle has no JSON store, `convex-test` is not a backend a child process can dial, and this repository has no local Convex backend harness. The host already proved the quote GET at `2d34a741` on an isolated backend. The `990bd8c2` re-proof passed capture and restore and failed the restart step before the child was given `JARVIS_DELIVERY_RUNTIME_TOKEN`. The harness now passes that token. Until the host repeats that restart step, realistic end-to-end recovery stays **NOT YET MET**.

`proveLocalV1Recovery` itself still does not spawn that process. Recovery is not complete. The function returns success only when these partial checks pass:

- `liveDirectory` equals the restore live data directory, before any restore write.
- The caller passed `readIsolated`.
- `restoreLocalV1Archive` is the only apply. The live data directory digest is the same before and after, including when restore throws.
- The archive has the business, core, and memory groups, `businessSettings` is present, and the V1 collections on those groups are arrays. An empty array is present. An omitted collection is not.
- The isolated JSON restore left a regular completion-marker file whose `completeness` is `partial`, the archive manifest stays `partial`, and the in-progress marker is absent.
- `assertRecoverable` still throws. A partial capture is not full recovery.
- The S6 and receipt sidecars list their tables in order. Each table entry still has only `table` and `documents`, at most 100 rows, a matching payload checksum, and no `skipped` or `truncated` key. The receipt payload may also list tombstones for direct-create receipts whose task or reminder was already deleted. Those receipts restore with the captured entity id so the idempotency key cannot create a replacement. A receipt with no entity and no matching tombstone is still refused. Payload size stays within the existing cap.
- Each captured PDF artifact has a blob file that is not a symlink, and the file's sha256 and length match the manifest.
- Two calls to the injected `readIsolated` callback return the same client, task, build, and quote ids, and an empty id fails the gate. A capture with no client, no task, no build, or no quote therefore does not pass.

Convex tests supply that callback. The node test calls `rereadIsolatedHttp`, which opens two `createJarvisHttpApp` instances on scratch stores and compares those four GETs. That stand-in is still not the restarted-process criterion. The OS-process harness above is `readRestartedProcess`. Its default matches client, task, and build only. Quote comparison requires an explicit isolated Convex URL. The two injected reads are still not the OS restart. `proveLocalV1Recovery` itself still does not spawn the process.

The gate fails closed if any row was skipped for size, if any PDF byte is missing, or if the Convex target URL equals the configured live URL. It does not flip `completeness` to `complete`. Recovery is not complete.

Point Danger zone `clear-local` at this gate, or stop accepting a classic verify receipt as sufficient when core, memory, or business files are in the quarantine set. A receipt that does not list those checksums must not authorise quarantining them. The explicit skip checkbox can stay; it already requires accepting irreversible loss.

### PR 5 — HARDEN: operator text

Recorded in `typescript/docs/operators/archive-v4.md`, `persistence-settings.md`, and `typescript/docs/ROADMAP.md`. Those pages say:

- which files are checkout-local;
- that v4 full recovery is still refused;
- that the Local V1 gate is the named check from PR 4;
- that classic restore writes the live provider.

No new runbook that tells the operator to restore onto the dev deployment.

### Not in this sequence

- A new database or a new business JSON layout.
- Sealing `notesAndEvidence` or `orchestration` just to turn `completeness` to `complete`. Those remain the v4 contract's later stages. Local V1 does not need ΩΣ history or #324.
- Cascade deletes. Dangling edges stay recorded.
- Raising the 100-row / 512 KiB S6 caps in order to go green. If a fixture does not fit, the capture fails and the cap change is its own reviewed change.
- Production deploy, `npx convex deploy`, or any run against the live dev data.

## 6. Data-safety risks in current behaviour

1. **Business data follows the worktree.** Clients, jobs, invoices, errands, and business settings are files under `<checkout>/typescript/data/`. They are not in Convex and, except `jarvis-state.json`, not gitignored. Deleting the worktree, checking out a different directory, or committing the files by mistake loses or publishes them. Convex tasks and quotes survive a worktree change; the clients those quotes point at may not.
2. **Supported backup does not include those files on the live provider.** `export-v4` refuses Convex. Classic export never reads them. An operator can believe a backup file exists and still have no copy of the business records.
3. **`clear-local` can quarantine the business files after a classic verify.** The files are renamed, not deleted, but the running app will treat them as absent. Convex rows are untouched, so quotes can remain while clients disappear from the checkout.
4. **Classic restore writes the live Convex deployment** when that is the configured provider. There is no empty second deployment in the command.
5. **Deletes do not cascade.** `JsonClientStore.remove` and the property, project, build, asset, and errand removes drop one row. Enquiries, invoices, flat quotes, and Convex quotes that still hold the id become dangling. v4 documents this and records it. Nothing stops the delete. Enquiries, invoices, and lifecycle quotes have no delete route, so smoke rows stay.
6. **Two quote authorities.** Brief and the quote CLI can show `jarvis-quotes.json` while HUD and `/api/v1/quotes` show Convex. Restoring only one of them splits the daily surfaces.
7. **Convex public ids are physical.** Copying a classic archive into JSON and back does not preserve the `_id` links build logs and task receipts use.
8. **A restored receipt must stay inert.** The S4 and S5 slices already refuse live leases and refreshed approvals. A wider restore that calls `finalize`, `quotes:send`, or `beginRun` would violate that. The new apply path has to insert rows, not invoke those commands.
9. **S6 business checksum is not a cross-store snapshot.** The Convex query and the JSON read are separate. A concurrent writer can change a client between them. The proof has to record that, and the isolated reread has to compare the captured bytes, not assume one transaction.

## 7. Owner decisions

Closed by the integration lead on 2026-10-07. See the decision list at the top of this file. Later PRs follow them:

- Isolated Convex work uses `convex-test` and an injected client. A URL equal to `process.env.CONVEX_URL` is a failed proof, not a target.
- The V1 gate does not include notes, project memory, ΩΣ, development history, or orchestration, and it does not set `completeness: complete`.
- `jarvis-quotes.json` is in the capture. The Convex lifecycle remains the quote authority.
- PR 4 stops `clear-local` from treating a classic verify receipt as cover for business JSON.
- `.gitignore` is not part of this slice.
- Fixtures stay inside the current S6 caps. Overflow still aborts.

## 8. What this file is not

It is not a recovery drill and not a claim that any archive on disk is restorable. PR 1 locks the split. PR 2 writes a partial capture only. PR 3 restores that capture into scratch JSON and an injected empty database. PR 4 names the proof gate `proveLocalV1Recovery`. The restarted-process criterion stays required. Client, task, and build GETs across a killed and respawned `src/http/main.ts` are met off-host on JSON. Quote GET across a real restarted process is **PROVEN** on host at main `2d34a741` with an isolated self-hosted convex-local-backend on `127.0.0.1` (evidence: host `~/lv1-01/restart-proof.md`, quote body sha256 `c7fd9977…dbb8`). That run used workarounds. A host re-proof of `990bd8c2` passed capture and restore and failed the restart step before the child was given `JARVIS_DELIVERY_RUNTIME_TOKEN`. The harness now passes that token. Full end-to-end recovery on realistic data stays **NOT YET MET** until the host repeats that restart step. It does not flip `completeness` to `complete`. Recovery is not complete. PR 5 records that gate in the operator docs. `assertRecoverable` still refuses the archive.
