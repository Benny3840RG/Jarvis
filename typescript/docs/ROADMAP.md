# Jarvis TypeScript Roadmap

## S4 closed component and risk restore (2026-09-23)

The existing unregistered S4 adapter now restores current component and risk
rows with the projects, notes, four-kind memory history, and rejected
`notes.create` actions it already admitted. Components require an empty
`attributes` object and a closed same-project `parentComponentId` graph. Risks
require canonical text and integer likelihood/consequence scores from 1 to 5.
Logical ids stay verbatim, so `UuidRemapper` is not used. Convex physical ids
stay on the existing table-scoped identity list. Verification returns
`completeness: partial` and `verifiedGroups: []`. `export-v4` does not seal
`notesAndEvidence`.

Still refused: non-empty component attributes, constraints, tasks, events,
tool execution receipts, external reconciliations, development bindings, omega
rows, and every live approval or lease. See
[the S4 restore slice](architecture/backup-v4-s4-restore-slice.md).

Next:

1. Classify a producer-specific component-attribute or constraint-value subset,
   or stop at this boundary until one exists.
2. Inert receipt and reconciliation restore, still without sealing the group.
3. Keep development and omega edges out until they can be restored with the
   closed terminal orchestration subset in one empty target.

## Backup id remapper (2026-09-23)

`src/backup/uuidRemapper.ts` is the old→new id map for paths that mint ids on
restore. Repeated lookups stay stable. `remapFields` / `remapArrayFields`
touch only named fields. `translateKnown` is the existing assistant-state walk
(replace a string only when it is already mapped). JSON empty-target restore
mints task and reminder ids through it, and v3 backup restore binds
store-assigned build ids before rewriting `buildLogs.buildId` and
`upgrades.buildId`.

Decisions: one remapper instance is not shared across tasks and reminders,
because those collections may reuse an id string; assistant state still keeps
the reminder id when they collide. Archive v4 is unchanged and still writes
logical business ids verbatim. `CROSS_DOMAIN_REFERENCE_FIELDS` names the
foreign keys a later minting restore must thread through this helper. It does
not add those domains to the v3 archive.

Not in this slice: clients, quotes, invoices, projects, properties, enquiries,
and errands in the v3 provider archive; `notesAndEvidence`; Convex mutation
restore (it keeps its own known-id walk); invoice payment ids; enquiry
attachment refs.

Next:

1. When a minting restore of the JSON business stores is actually required,
   bind or remap every primary id, then `remapCrossDomainReferences`, and fail
   closed on an unknown foreign key. Do not bolt that onto v4's verbatim write.
2. Point the Convex assistant-state restore at the same known-id rule without
   importing Node-only backup code into a mutation, if that duplication starts
   to drift.
3. Do not point `notesAndEvidence` logical ids at `UuidRemapper`. The isolated
   S4 subset preserves them; the archive group stays unsealed.

## S5 terminal orchestration restore (2026-09-23)

Isolated Convex adapter for closed terminal orchestration history only.
`backupS5.capture` reads owner-scoped runs, steps, and reconciliations without
validating terminal shape. `restoreS5TerminalOrchestration` is an unregistered
helper: empty application database, typed physical-id maps, logical ids kept.
Restore admits succeeded/failed runs, non-retryable terminal steps with no live
lease fields, and non-pending reconciliations whose trigger payload is on the
producer allowlist. Verification returns `completeness: partial` and
`verifiedGroups: []`. Tests prove idempotent `beginRun` replay and that
`markStepRunning` / `retryFailedStep` cannot restart restored rows.

This does not cover `notesAndEvidence`. It does not restore queued, running, or
indeterminate runs, retryable failures, live leases, pending reconciliations,
unclassified trigger payloads, `directCreateReceipts`, `internalActionResults`,
or external effect receipts. `export-v4` is unchanged, so written archives stay
partial and full recovery still refuses them. No archive group is sealed.

See [the v4 contract](architecture/backup-v4-contract.md) S5 section.

## Policy subjectVersion and transitionCommitted (2026-09-23)

Policy ordering reuses the policy aggregate's `subjectVersion`. Approvals
snapshot it as `policySubjectVersion`; there is no second `sequenceNumber`.
An approval is consumed when its bound transition commits
(`transitionCommitted`). That is not mission `COMPLETE`, which stays the
ΩΣ-only state. `PENDING_ONLY` invalidation skips consumed approvals.
`affectedApprovals: "ALL"` is admissible in this phase only at risk class 3
with an audit trail. Rate limits, dual confirmation, and a counted blast
radius are not implemented.

The development merge commit copies `policySubjectVersion` from the approved
tool-action arguments and refuses the transition when that snapshot is missing.
A committed transition event records `approvalTransitionCommitted: true`.
No live provider or deployment was run.

## OpenClaw Retry-After and MCP deadlines (2026-09-23)

Provider throttling no longer schedules the next reconciliation attempt earlier
than a parsed Retry-After. Microsoft Graph 429 responses accept delta-seconds,
including values above the previous 300 second drop, and IMF-fixdate values
measured from an injected clock. A past date is an elapsed wait of zero. Junk
and obsolete date forms still produce no provider minimum. A delay that cannot
be represented as a safe future timestamp escalates as
`provider-retry-after-unschedulable` instead of being shortened. Local
exponential backoff remains a separate floor and is still capped by `maxRetryMs`.

The MCP preview's `JarvisApiClient` now aborts every backend call at 30 seconds
by default, or `JARVIS_MCP_BACKEND_DEADLINE_MS` when set to an integer from 1
to 120000. An invalid setting fails closed at configuration. Closing the MCP
HTTP response before it finishes cancels the outbound call. This does not roll
back a Jarvis HTTP mutation that has already been accepted, and it does not add
Totality caller-disconnect cancellation or durable cross-process quotas.

No live Microsoft Graph request, ChatGPT session, or deployment was run.

## OpenClaw provider resource guards (2026-09-20, #574)

Acquired portable patterns from OpenClaw v2026.9.5, pinned to
`ec9c1a13db8938e5a3eaa51fca2e981cde2395a9`. Totality admission now counts each
production adapter's complete serialized request, including stored project
context, instructions, routing and schema. The incoming request remains
independently bounded. Both model clients use a 1 MiB streaming response cap and
keep their timeout active through body consumption. Oversized inputs fail before
dispatch; response overflow fails without a retry or staged memory. No new
runtime dependency, authority or persistent state was added.

Review follow-up requires every injected reasoner to expose its full wire
serializer and rejects missing serializers before dispatch. The Totality 413
contract describes its configured request limits independently of backup limits.

See [acquisition and provenance](architecture/openclaw-acquisition-2026.9.5.md)
for the retained MIT licence, adopted patterns, failure-first regressions and
components deferred after inspection. Exact candidate verification belongs to
the draft PR; this entry does not establish live-provider or deployment proof.

Provider-directed Retry-After minimum waits and MCP backend deadlines are
implemented by the 2026-09-23 follow-up above. Remaining bounded candidates:
scope durable provider quota accounting, and Totality caller-disconnect
cancellation. Automatic model retries need per-attempt cost and ambiguity
controls before adoption. Existing Temporal and deployment PR ownership is
unchanged.

## Maintenance notification repair (2026-09-16, #548)

Run `35058594031` correctly deferred #522 and #553 for base drift, but its
diagnostic PR comments failed with HTTP 403. The trusted prepare job now requests
`pull-requests: write` instead of `issues: write`; contents and checks remain
read-only, and the isolated reviewer receives no write permission. A regression
asserts the complete coordinator permission set and trusted checkout boundary.

The earlier #553 publisher failure is a separate development-backend mismatch:
run `34944213898` reached the durable verification-evidence write, but the
configured development deployment does not expose
`developmentEvidence:recordDevelopmentEvidence`. The subsequent new review run
`34944398486` was correctly refused as an existing exact-candidate attempt;
`34959648275` supplied an empty fingerprint and was also correctly refused.
No retry budget, candidate binding, mission lock or durable checkpoint was reset.
The #552 mission remains `VERIFYING` at version 5, bound to #553 head
`21ea7e6b50c7915bd69e0d6c9075ff40fc884a2d`; the published head is now
`734c7f11a86760de3fbcd16bd093181011623447`. A branch update alone cannot satisfy
that checkpoint. The existing admission path refuses a new worker from
`VERIFYING`; neither a fabricated review nor a direct checkpoint rewrite is a
valid recovery.

Next: obtain owner-controlled deployment/reconciliation of the missing development
function, refresh #553 through its existing autonomous owner with a matching
durable checkpoint, then collect fresh CI, independent review and Jarvis evidence.
The notification fix itself requires owner merge before the trusted main workflow
can demonstrate successful bot comment publication. No live dashboard or runtime
configuration was changed by this maintenance repair.

## Concurrent recovery and authentication hardening (2026-09-15, #548)

Reproduced and repaired two runtime failure classes:

- A core or domain JSON reader could capture corrupt bytes, then quarantine a
  valid replacement published by another writer. Corruption recovery now takes
  the existing writer lock and re-reads before moving anything. Healthy reads
  remain lock-free; locked writers and snapshots reuse their held lock. Tests
  cover all three core read methods and all 25 business/memory read entry points.
- Concurrent OIDC verification downloaded the same JWKS eight times for eight
  callers. Downloads now share one pending promise, cleared on success or failure.
  Regressions cover cold and expired caches, rotated keys and recovery after a
  failed download, using signed tokens.

No persisted schema, archive format or endpoint contract changes. Full checks,
independent review and the Jarvis gate are recorded against the draft PR head.
These repairs do not establish production or external-provider evidence.

Next: assess directory-entry durability after the shared JSON publisher's rename
and concurrent stale-lock reclamation; both need fault/recovery evidence before
claiming a fix. Complete the separately tracked production recovery engineering
and commissioning work in #307; retain the partial-v4 restore limitations.

## Audit findings and JSON write repair (2026-09-15)

Fault audit of the TypeScript runtime found one high-confidence production defect in this candidate: domain JSON stores (`jsonInvoiceStore` and the other `json*Store.ts` writers) published files with `open(..., "w")`, no `0o600`, and no `fsync`. Core state, backups, and token files already used exclusive `wx` + `0o600` + `sync`. On a typical umask of `022` that made invoices, clients, quotes and related business files world-readable, and a crash could leave a truncated file after rename.

Fix: shared `writePrivateJsonFile` in `src/persistence/atomicJsonFile.ts`, used by the thirteen domain JSON stores and `JSONPersistence`. Tests force umask `0` and assert `0o600`, plus leftover temp cleanup when rename fails.

Not fixed here (already open PRs or documented limitations):

- High / already in flight: spoofable `X-Forwarded-Proto` (#542); invoice payment without `Idempotency-Key` (#543); stale "five" safety-category status copy (#540).
- High / documented: v3 restore and `importMemoryStores` are not atomic across memory domains; v3 export reads through forgiving store `list()` which can coerce or drop malformed rows.
- Medium: JSON stores skip malformed rows instead of quarantining; JSON `buildId` is not existence-checked (Convex is); MCP preview HTTP has no caller auth on loopback.
- Auth/token HTTP guards, secret redaction, OIDC verification, MCP operation↔OpenAPI parity, and v4 restore guards were reviewed and not found broken.

This file is a living record for the autonomous engineering sessions working on
Jarvis: current state, what changed recently, and what to pick up next. Update
it at the end of every session.

## Dependabot compatibility repair (2026-09-14)

- Runtime and compiler constraints are declared in `typescript/package.json`;
  update grouping and the Node type hold live in `.github/dependabot.yml`.
- Separate major upgrades from the root production/development dependency groups;
  keep `@types/node` on the Node 24 runtime line.
- PR #522 retains the Redocly CLI, convex-test, ESLint and typescript-eslint
  updates while retaining TypeScript 6.0.3 and Node 24 types.
- PR #520 separately retains Fastify and Zod updates while keeping the MCP Apps
  1.x API until an intentional SDK 2 migration.
- Next: migrate MCP Apps with the split SDK 2 packages and protocol tests; revisit
  TypeScript 7 once the lint toolchain supports its compiler API and peer range.
- Fresh CI is required for each repaired head before the owner merge decision.

## Standing Development review repair (2026-09-15)

PR #537's recovery classifier now refuses missing, unknown and contradictory
diagnostic stages instead of coercing them into retry authority. Guarded source
changes require added lines in their corresponding module test; unrelated area
tests, deleted tests and rename-only changes cannot satisfy the guard. Both
defects were reproduced before repair. The two-retry budget, independent review,
owner merge and deployment boundaries remain unchanged.

Implementation and regression sources: `.github/automation/autobuild-recovery.mjs`,
`.github/automation/autobuild-recovery.test.mjs`,
`.github/automation/validate-autobuild.mjs` and
`.github/automation/validate-autobuild.test.mjs`. Test filenames and keyword scans
do not prove behavioral correctness. Current-head checks and independent Jarvis
review remain required before Benny's merge decision. No live issue execution or
deployment is established by these local repairs.

Independent review also exposed retry-budget persistence ordering, stale-run
recovery and contradictory verification-result gaps. The workflow now records
the retry before unblocking, refuses source-run replays, and confirms a complete
bounded provider history before changing eligibility. The classifier validates
verification outcomes against build/publication state. Executable workflow
regressions cover the reproduced failures.

## Review artifact regression follow-up (2026-09-15)

After PR #541 merged, its test-only follow-up adds a regression combining a
root `result.json` with one and then two valid named segment directories, asserting
that neither layout retains any receipts. This closes the explicit mixed-layout
coverage gap; the publisher implementation is unchanged. The test-only candidate
requires fresh full verification, Claude review and maintained PASS before Benny's
merge decision. See `.github/automation/pr-maintenance-workflow.test.mjs` and
`.github/workflows/jarvis-pr-maintenance.yml` for the exercised authority path.

## Outlook current-main integration (2026-09-14)

Current base is `6b6ced5e5c3c32ca0eb9d06fbd56d73dac7acddc`. Benny has
merged the documented-context planner (#534), base-drift diagnostics (#532),
Sentry tooling (#527) and server-clock repairs (#535/#536). The held Outlook
source map can now use the trusted planner. This integration preserves both
sets of documentation and requires fresh exact-head proof and review. The
following paragraphs retain the earlier implementation/review history.

PR #482's integration with main `40393d04` preserves its separate personal and
business Outlook runtime and the current verification controls. The package
script conflict retains both `outlook` onboarding and main's single-worker
Convex test scheduling; the main lockfile is unchanged. Existing focused
runtime tests prove sender binding, OAuth isolation and uncertain-effect
reconciliation. Fresh full verification and independent review are recorded on
the existing PR before Benny's merge decision. #293/#294/#297 remain open for
approved live consent and provider evidence; no Microsoft effect is performed.

Jarvis review of integration head `cbcb09b` found a valid foreign-pagination
test gap. The mock now records every requested URI and fails if the foreign
target is invoked, even when setup later rejects and creates nothing. A temporary
guard-bypass mutation passes the old test and fails the repaired test; the intact
guard passes. Collection reads also select `HashTable` explicitly. The Microsoft
SDK already defaults to that type; the review's claimed `PSCustomObject` default
was incorrect. Fresh exact-head full verification and re-review remain required.

The next review found relative setup paths and an unclear unsupported-platform
failure. Setup now rejects non-absolute paths before filesystem/provider effects.
Browser onboarding explicitly requires POSIX ownership support before inspecting
the credential directory or starting consent; native Windows ACL storage remains
unsupported. The owner/private-directory guard is preserved. Regressions prove
both rejections occur before external actions; full verification and reviews
are recorded against the resulting PR head.

Further review exposed two pagination-test false positives: incomplete first-page
principal/grant records rejected even when later pages were ignored. The fixtures
now put complete exact records on the first page and ambiguity on the second,
assert the second-page request and reject configuration/grant advancement.
Ignoring every nextLink passes both old tests and fails both strengthened tests;
normal pagination passes. The evidence matrix distinguishes the integration merge
from the cumulative Outlook implementation and later repairs. Runtime ambiguous
collection rejection is unchanged.

The next runtime hardening increment explicitly rejects unsupported setup
platforms before filesystem/Graph effects, serves the registered localhost OAuth
callback through both IPv4/IPv6 loopback sockets, and closes partially bound
listeners before consent. Initial credentials now use the existing token store's
private temporary-file/fsync mechanism with atomic no-clobber publication (the
same hard-link pattern already used by JSON locking). Regression tests reproduce
partial-write/fsync leftovers before the repair and prove their absence after it,
plus concurrent creation, both callback families and partial listener cleanup.
All live provider and production gates remain open; exact-SHA full/review evidence
is recorded on the PR.

## Sentry commissioning tooling — #303 (2026-09-14)

The bounded development CLI reuses the existing commissioning app, API-client
error/measurement path and native Sentry envelope transport. An optional delivery
observer exposes accepted, rejected and indeterminate transport outcomes while
ordinary telemetry remains best-effort. The CLI requires explicit development
configuration and a clean source checkout, emits two synthetic observations,
and reports event IDs without DSNs, tokens or payloads. Late acceptance cannot
rewrite a timed-out observation; responses may arrive in either order.

Issue #303 is now closed with [Claude's provider-readback evidence](https://github.com/Benny3840RG/Jarvis/issues/303#issuecomment-5658528064)
for source `40393d04a31db81b2802199e3f234e99b4085464`: the synthetic error,
latency/failure spans, release/environment identity, redaction inspection and
issue-alert trigger were observed in Sentry. That proof exercised the existing
runtime directly; it does not claim this new CLI was used or that the aggregate
metric-alert thresholds fired. No provider probe was repeated during integration.
See [the commissioning runbook](operators/sentry-commissioning.md). Next: fresh
verification and independent Claude/Jarvis review of #527 against current main,
then Benny merge. Production authority remains separate.

## Live Work review repair (2026-09-14)

Benny merged PR #502 as `e9b76439dd0afdf0846a872c74ff16af89524626`.
Issue #398 is now closed with owner-recorded live merge evidence. The following
paragraphs preserve the earlier review history and do not reopen those gates.

Earlier review record: Review run `34736290718` exposed two reproduced defects: CRLF
objectives made the read projection unavailable, and accepted multiline
objectives escaped terminal row framing. The adapter now canonicalizes CRLF;
terminal rendering flattens line breaks before clipping both objective rows.
Claude's independent review also identified duplicate mission labels. The stable
`issue` node now displays ISSUE/unavailable rather than presenting mission
progress or subject IDs as provider issue evidence.
Stored objectives and completion authority are unchanged. Regression evidence
and remaining gates are recorded in the production completion ledger.

Next: full candidate verification, Claude review, then current Jarvis PASS.
Jarvis run `34795454961` returned 15 passes and one context request for an
unrelated notes-route description. That correction is removed from #502's scope;
the notes documentation follow-up must include its existing handler/test context
and independently establish the execute route. The blocked result is preserved,
and the narrowed candidate requires new verification and review.
Priority 1 issue #398 still requires owner activation/readback and an ordinary
PR drill; PR #526's green review alone does not establish live enforcement.
Priority 2 commissioning and Priority 3–4 recovery/orchestration gates remain
open; this rendering repair does not complete them.

## Recovery engineering update (2026-09-11)

The bounded recovery candidate now captures existing S4 evidence and mutable-quote
inventories and proves the supported closed subset through ordinary stores. Its
joint primitive uses one Convex transaction, exact shared rows, typed identities,
and actual JSON business digests. It remains partial and unregistered for restore.
The archive payload/marker coordinator, remaining effect/history domains, blobs
and real provider recovery drills are still engineering work; external account
gates do not make these local gaps complete. See
`docs/architecture/backup-v4-s4-restore-slice.md` for exact support and limits.

## PR handover work (2026-09-10)

- Added trusted automatic advisory PR review with isolated reviewer/publication
  jobs and exact head/base/CI evidence binding. Same-repository PRs receive review;
  only authentic approved builder candidates receive automatic repair authority.
- Extended the existing builder with two-attempt, same-PR repairs. Cumulative
  forbidden-path/content guards, trusted controls, owner merge and queue locking
  remain enforced. Candidate verification now authenticates every required producer.
- Hardened post-merge GitHub evidence and merged-head reconciliation. Missing or
  neutral/skipped checks, wrong producers and different reviewed heads fail closed.
- Added a development-only executable post-merge completion command that loads
  existing durable bindings before using the established Omega gateway.
- Local validation is recorded in the Phase 1 working ledger. Live activation is
  pending this control-plane PR landing and the drill in
  `docs/operations/pr-maintenance.md`; no live completion is inferred here.
- Added durable Actions admission, isolated worker-lease supervision, head-bound
  verification/review checkpoints, owner ToolAction proposal and post-merge
  completion scheduling. Issue acceptance criteria stay unverified until real
  independent evidence is recorded through the existing Omega authority.
- Next: deploy the bridge to the authorised development runtime, configure its
  credentials/explicit uncertainty decisions, and run an owner-approved live
  issue through the full handover. Local tests do not close commissioning.

## Current state (2026-09-08)

- `npm run check` (hygiene + `tsc` + ESLint + Prettier + OpenAPI lint + Node
  tests + Convex/vitest tests) passes cleanly: 1174 Node tests, 0 failures.
- The codebase is mature and broad: a maintained TypeScript CLI plus HTTP and
  private ChatGPT/MCP adapters, a Totality reasoning/approval system, and a
  full trade-business domain layer (clients, quotes, invoices, projects,
  properties, enquiries, errands, assets, builds, upgrades, business
  settings, preferences) each with parallel JSON and Convex-backed stores.
- No `TODO`/`FIXME` markers exist in `src/`.
- There is a separate, tightly-controlled autobuild/queue automation system
  (`.github/workflows/jarvis-autobuild.yml` and friends) with its own bounded
  worker, draft-PR-only publication, and exact-candidate verification. Issues
  scoped to that control plane (currently #462, #472, #473) are written for
  that dedicated worker, not for a general autonomous session — leave those
  alone unless explicitly asked to pick one up.
- Several open GitHub issues (#293, #294, #297, #302, #303, #306, #307, #324)
  are external commissioning gates (Outlook OAuth, Sentry, PostHog, a real
  OIDC provider, production deployment approval). These need operator-supplied
  credentials/decisions and are not actionable by an autonomous coding session.

## Outlook separate connections (2026-09-09)

- Added opt-in named personal/business Outlook connections with separate app IDs,
  tenant-pinned business authority, token files and per-connection caches.
- Quote approvals explicitly bind the sender configuration; durable references
  route sends/reconciliation to the same account after restart. No fallback.
- Added browser PKCE onboarding, read-only verification and an operator setup
  script for separate registrations and single-user business consent. It does not
  relax tenant policy, enable the runtime, send customer email or deploy.
- Live Microsoft provisioning, both mailbox sign-ins, and per-account governed
  draft/send/reconciliation evidence remain outstanding (#293/#294/#297).
- See `docs/runbooks/outlook-delegated-oauth.md` for setup and migration boundaries.

## Production reconciliation (2026-09-11)

Base: `fae9949fc1f9d1ce15729608384a6d32ec40b8cb` (PR #501).

- Archive v4 captures core, memory, business records and settings. The isolated
  restore verifier reads ordinary stores and verifies references and digests.
  The old S1-only/S2-next status is superseded by merged #492 and #501.
- Complete recovery remains unavailable: notes/evidence, durable orchestration,
  quote aggregates/delivery history and artifact recovery still need capture,
  domain-aware restoration and read-back proof. Group presence alone is not proof.
- Development Live Work is being completed on the existing Convex/HTTP/MCP path.
  Idle, unavailable and ambiguous selection are distinct; ΩΣ readiness cannot
  commit COMPLETE. Current ΩΣ storage does not persist residual uncertainty,
  so the read-only query honestly reports that missing readiness input.
- Current evidence and remaining commissioning gates are recorded in
  [the production ledger](../../docs/operations/production-completion-ledger.md).

## This session's work

**Development specification validation.** Empty or whitespace-only GitHub issue
titles are now rejected with the machine-readable `TITLE_EMPTY` reason, while
surrounding whitespace on valid titles remains normalized before hashing.

**Backup/restore coverage gap (priority area 7).** `npm run backup` only ever
covered `state`/`tasks`/`reminders` (`src/backup/backup.ts`), even though the
app has grown 13 more JSON-backed domains living in their own files under
`data/` (`jarvis-clients.json`, `jarvis-quotes.json`, `jarvis-invoices.json`,
`jarvis-projects.json`, `jarvis-properties.json`, `jarvis-enquiries.json`,
`jarvis-errands.json`, `jarvis-assets.json`, `jarvis-builds.json`,
`jarvis-build-logs.json`, `jarvis-upgrades.json`,
`jarvis-business-settings.json`, `jarvis-preferences.json`). A disaster or a
bad restore would have silently dropped almost all real business data.

Fixed in this session, backup archive version bumped 2 -> 3:

- `builds`, `buildLogs`, `upgrades`, `assets`, and `preferences` — the exact
  five-domain "memory store" bundle `npm run import:convex` already treats as
  one unit (`src/importer/importMemoryStores.ts`) — are now included in
  export/verify/restore. `runBackup.ts` wires provider-aware (JSON or Convex,
  per `PERSISTENCE_PROVIDER`) stores for all five.
- `buildLogs.buildId` and `upgrades.buildId` reference `builds.id`. Restore
  regenerates build ids (stores don't accept a caller-supplied id) and remaps
  those references through an old-id -> new-id map, verified by a
  content-signature check (`assertRestoredMemoryStores` in `backup.ts`).
- Fixed a related, confirmed bug in `importMemoryStores.ts`: it copied
  `buildId` verbatim from source to target without remapping, so a real
  `npm run import:convex` run would silently orphan every build log/upgrade
  (the existing test's `buildId: "b-1"` literal never matched a real created
  build's id, which is how this went uncaught). Now fixed with the same
  remap approach, plus a regression test and a fail-closed check for a
  build log/upgrade referencing an unknown build id.
- Legacy v1/v2 archives still parse fine (the five new fields default to
  empty); restoring one doesn't require supplying memory stores. Restoring a
  v3 archive that _does_ contain memory-domain records without supplying
  memory stores is refused rather than silently dropping that data.
- 17 tests in `tests/backup.test.ts` (up from 10), including a real
  JSON-file end-to-end round trip, a non-empty-target refusal per domain, and
  malformed-record rejection. `tests/importMemoryStores.test.ts` covers the
  buildId-remap fix.

**Known limitation, documented in code and README:** unlike the atomic
state/tasks/reminders restore, restoring the five memory domains is NOT
atomic — it's one `add()` call per record (same limitation
`importMemoryStores.ts` already had). A failure partway through a large
memory-domain restore can leave a partial set of records. This is
acceptable for now (up-front emptiness checks mean the only way to fail
partway through is a genuine store error, not a refused precondition) but
worth revisiting if backup restore becomes a routine disaster-recovery path
rather than an occasional operator action.

## Next steps

Provider Retry-After minimum waits and MCP backend deadlines shipped in the
2026-09-23 section above. They are not open work.

1. **Complete remaining archive v4 domains.** Core/memory and cross-referenced
   business records are implemented in v4. A closed terminal orchestration
   subset now restores through an isolated adapter (see the 2026-09-23 note):
   logical IDs kept, physical IDs mapped, empty destination required, no group
   seal. Still refused: `notesAndEvidence`, queued/running/indeterminate runs,
   retryable steps, live leases, pending reconciliations, unclassified trigger
   payloads, idempotency/effect receipts, and quote aggregate/blob recovery.
   Follow [the v4 contract](architecture/backup-v4-contract.md).
2. **Quote delivery / PDF artifact backup.** The delivery-attempt/outcome ledger
   is authoritative history, including failed and indeterminate outcomes;
   re-sending cannot restore it. PDF bytes are only conditionally regenerable
   from the full aggregate/revision snapshot, stored issuer/client/generatedAt
   and pinned renderer, with a verified digest. Blob backup remains in scope.
   See the [domain inventory](architecture/authoritative-domain-inventory.md)
   and [v4 contract](architecture/backup-v4-contract.md).
3. **Remaining OpenClaw guards.** Scope durable provider quota accounting, and
   cancel Totality work when the caller disconnects. Do not add automatic paid
   model retries until per-attempt cost and ambiguity controls exist.
4. **`personalTraitsService.ts` dead code.** `addNote` and `priorityRank` on
   `PersonalTraitsService` (`src/runtime/personalTraitsService.ts`) are
   unused anywhere in the codebase or tests (only `dailyBrief`/`motivation`
   are wired into `cli.ts`). Low priority cleanup: delete them, or wire them
   up if they were meant to ship.
5. **Convex test coverage measurement.** `npm run test:coverage` only
   instruments `tests/*.test.ts` and `jarvis-console-01/tests/*.test.ts` via
   Node's built-in coverage; the parallel `convex/*.test.ts` suite (running
   under vitest via `npm run test:convex`) isn't included in that report, so
   the coverage numbers for Convex-adjacent modules
   (`convexQuoteDeliveries.ts`, etc.) understate real coverage. Not urgent,
   but worth combining the two reports if coverage numbers start driving
   decisions.

## Notes for future sessions

- Before touching `.github/workflows/jarvis-autobuild.yml` or its automation
  policy tests, check whether the task is actually meant for the dedicated
  autobuild worker (see "Current state" above) — those issues carry very
  specific scope boundaries and evidence requirements that assume a
  different execution model than a general session.
- `PERSISTENCE_PROVIDER` (`json` default, or `convex`) governs builds,
  buildLogs, upgrades, assets, preferences, and notes the same way it governs
  core state/tasks/reminders — see `selectMemoryStore` in `src/http/app.ts`
  for the canonical per-domain provider-selection pattern; `runBackup.ts`'s
  `createMemoryStoresFromEnv()` mirrors it for the CLI.
- Business settings (`src/businessSettings/`) has no Convex-backed store yet
  (`JsonBusinessSettingsStore` only) — flag this if `PERSISTENCE_PROVIDER=convex`
  commissioning ever depends on it.

- Repaired the post-merge #491 handover findings: exact completion bindings, trusted check selection, non-poisoning retry observations, issue-bound repair provenance, guarded failed checkpoints and independently observed unpublished-worker recovery.
- Added stable completion pagination and finalisation after both durable authorities complete; retained explicit owner reconciliation for published/uncertain dead workers and stale, closed or terminal merge candidates. See `docs/operations/issue-493-owner-handoff.md`.
- Next: owner-approved control landing with #496, exact development commissioning, then #493's real build/review and separately approved merge/post-merge acceptance proof. No live lifecycle completion is claimed from regression tests.
- Development admission now selects an issue-specific uncertainty-budget variable; approving one issue cannot supply a default budget to another. Residual uncertainty and owner merge gates remain separate.
- Live PR-maintenance failures led to bounded, digest-checked prompt-file transport and the isolated publisher permission required for PR comments; model execution remains read-only.
- Removed the redundant reviewer `--skip-git-repo-check` argument after the live #493 review proved that the pinned Codex action already supplies it.

## Development merge observation compatibility

- Pin only GitHub PR-detail reads to API 2022-11-28 because 2026-03-10 removed `merge_commit_sha`; preserve actual provider SHA checks for reconciliation and completion. Other requests retain their current API version.
- Issue #493 live proof exposed the mismatch after a succeeded governed merge. Preserve the inconclusive observation; retry only after a fresh provider observation includes the actual merge SHA.
- Remove the completion observer self-dependency using exact workflow/app/commit/branch/event provenance; retain all required CI and unrelated-failure gates, plus prior inconclusive proofs.

## S4 bounded capture primitive (2026-09-11)

- Added owner-scoped, one-transaction raw Convex capture for all 17 S4 tables,
  preserving complete source rows and tagged Convex values with lossless checks.
- This is capture material only: no `notesAndEvidence` archive coverage or
  restored verification is credited. See [the S4 capture boundary](architecture/backup-v4-s4-capture.md).
- Next: inert empty-target restore, typed references (including S5 links),
  ordinary-store read-back and source/restored digest proof before integration.

- S4 isolated restore increment: projects/notes-only typed adapter, exact capture
  integrity/inventory checks, fresh application-database refusal, atomic schema-backed
  insertion, typed source-ID metadata and ordinary-store/digest readback. All other
  nonempty S4 tables fail closed; verification returns partial with no verified group.
  Remaining S4 logical/physical/opaque references are classified in
  `architecture/backup-v4-s4-restore-slice.md`; project memory and effect-history
  inertness plus S5 bindings remain required before whole-group coverage.

- S4 terminal project-memory increment: same isolated adapter now supports the four
  existing memory-record kinds, applied/rejected change sets and their exact typed
  memory audit history. Ordinary grouped/service reads and tagged digests verify
  restoration; replay tests prove no new records, revisions or audit writes. Active
  proposals, arbitrary payloads and effect/worker histories remain unsupported;
  whole-group coverage remains partial with no verified group.

### Outlook verification boundary follow-up — 2026-09-14

PR #482 now checks private current-user directory ownership before `verify`
reads or refreshes an existing credential, with failure-first coverage for
shared/writable and wrong-owner directories and a valid rotation control.
The runbook uses complete legacy environment-variable names. OpenAPI clarifies
that generic staging and tool-specific execution validation are separate;
named sender identity is checked against the active provider manifest at
execution, while legacy mode omits it. Microsoft SDK source confirms the
explicit Graph `HashTable` output is supported; that review finding is false.
Live Outlook commissioning and Benny's merge remain separate gates.

### Outlook serialized-token boundary repair — 2026-09-14

PR #482 repairs the shared token store's size mismatch: its existing 64 KiB
payload limit is preserved while the file-read bound now accounts for the
single newline appended by initial publication and rotation. ASCII and
multibyte maximum-size tokens round-trip; one-byte-over payloads remain
rejected without replacing an existing credential. The runbook distinguishes
legacy personal/business tenant settings from named connection configuration.
This remains offline repository proof; live commissioning and merge gates
are unchanged.

### Outlook single-stack callback follow-up — 2026-09-14

PR #482 now handles unavailable IPv4 and IPv6 families symmetrically, skipping
only a family not present in localhost resolution. Failure-first coverage
reproduces IPv6-only startup failure and verifies both single-stack cases;
required-family failures still close the existing listener before consent.
The PowerShell exit finding from run 34802974904 is false: executing a child
script with `&` returns control and its exit code to the calling script, as
proven in the actual PowerShell host. Existing harness assertions remain active.

### Outlook setup dependency boundary — 2026-09-14

PR #482 removes automatic PowerShell module installation from administrator
setup. It requires a preinstalled, operator-validated Microsoft.Graph.Authentication
2.36.1 distribution and explicitly imports that version. Missing or different
versions stop before setup state, module execution or administrator sign-in.
The version check does not claim package integrity; the runbook records the
separate trusted software provisioning prerequisite. All 31 offline provisioning
scenarios pass, including two regressions that fail on the old installer path.
Live OAuth and provider commissioning remain unproven.

### Outlook documentation review context — 2026-09-14

PR #482's runbook now names the authoritative provisioning, callback, token-store
and connection-composition files and their offline regressions. The source map
addresses the reviewer's explicit context request without changing runtime code
or treating documentation as provider evidence. Issue #533 repairs the existing
bounded planner's lookup of these paths and is now merged through #534.
Current Jarvis PASS remains unproven until this integrated candidate is evaluated.

### Review base-drift visibility — issue #529

The PR maintenance coordinator retains the exact-main review guard and records
base mismatches in an owner-visible GitHub comment. It reuses the existing
workflow and comment transport, recognizes its own diagnostic notice, updates
changed observations and leaves identical observations untouched. Bounded comment
reads, candidate re-observation and provider readback prevent false publication
claims. An unavailable notice does not stop another eligible candidate. The
trusted coordinator gains issue-write permission; the model remains read-only.
This comment is diagnostic and never grants review, scheduling, approval or
completion authority. Live notification proof awaits owner merge to main.

Next: independent Claude review, current Jarvis evaluation, then Benny's merge
decision and an observed stale-base notice from the maintained workflow.

### Documented implementation context — issue #533

PR #482's bounded review exposed an omitted documentation-to-code relationship.
The existing fetched-inventory resolver now follows explicit unambiguous local
paths from Markdown and retains both revision references. It does not fetch
external URLs, guess basenames, or create cross-code graph bridges through shared
documents. Regression coverage proves a separated documentation segment receives
its implementation while exact coverage and prompt limits remain intact. Missing
essential context still blocks.

Next: full verification, independent Claude review, current Jarvis evaluation,
then Benny merge before any live review claims can use the repaired planner.

## Outlook browser-launch deadline

The #482 maintained review found that a stalled URL-display callback could prevent the sign-in timeout from reaching cleanup. The minimal repair bounds launcher completion and code receipt together, including when a valid callback arrived first. Two offline regressions failed before the fix and now prove listener closure and no token/provider effects on expiry. Fresh review remains required; live #293/#294/#297 commissioning stays open.

## Single-artifact review publication compatibility

The pinned `actions/download-artifact` revision flattens one matched artifact into the destination even when `merge-multiple` is false. This blocked #540 after its sole reviewer returned valid evidence. The existing publisher now accepts that exact flat `result.json` layout only when its trusted manifest expects segment zero alone, while retaining named-directory loading for multiple artifacts. File/manifest byte bounds, regular-file checks, exact indices, run/attempt directory names and downstream manifest/prompt digest verification remain enforced. A failure-first test executes the actual workflow loader; negative fixtures cover mixed layouts, wrong indices/identities, oversized files, invalid JSON and symlinks. Local proof does not override the blocked provider result; fresh Claude review, maintained PASS and Benny merge remain required.

Implementation and proving coverage: `.github/workflows/jarvis-pr-maintenance.yml` and `.github/automation/pr-maintenance-workflow.test.mjs`. These exact changed files supply the flat/named artifact loader and its negative fixtures; review them together with these documentation claims.
