# Jarvis TypeScript Roadmap

This file is a living record for the autonomous engineering sessions working on
Jarvis: current state, what changed recently, and what to pick up next. Update
it at the end of every session.

## Phase 1 nested assistant-state validation (2026-09-10)

- Extended the shared provider guard to reject nested non-finite numbers and
  circular references. JSON previously converted NaN/infinities to null while
  Convex could retain them, producing different persisted state.
- Expanded both provider tests before implementation and observed failures.
  Coverage includes nested objects/arrays, NaN, both infinities, cycles,
  preservation of previous state, and valid shared references/zero/null values.
- This remains a bounded validation step, not a complete JSON-serialization
  contract. Direct Convex server upsert validation remains next, followed by
  non-JSON values such as dates, undefined, and custom serialization methods.
- `npm run check` passed: 1,191 Node tests, 227 Convex tests, TypeScript,
  ESLint, Prettier, hygiene, and zero-warning OpenAPI lint. Development Convex
  smoke passed with cleanup; no server deployment was changed.

## Phase 1 assistant-state write validation (2026-09-10)

- Both provider classes now reject null, arrays, and primitive root state
  values before disk writes or Convex mutation calls. This prevents JSON
  object-spread coercion from silently replacing saved state.
- Two provider-parameterized regression tests failed before implementation.
  They cover seven invalid inputs, prior-state preservation, unchanged JSON
  bytes, no invalid remote mutations, nested custom fields, and empty objects.
- The shared `assistantState.ts` guard validates root shape only. Direct
  Convex server calls and nested field/serialization validation remain separate
  work; existing backup formats are unchanged.
- `npm run check` passed: 1,191 Node tests, 227 Convex tests, TypeScript,
  ESLint, Prettier, hygiene, and zero-warning OpenAPI lint. Development Convex
  smoke passed all domains with cleanup; no server deployment was changed.
- Next: audit nested assistant-state serialization and direct Convex upsert
  validation, then review remaining Phase 1 invariants before Phase 2.

## Phase 1 completion audit (2026-09-10)

- Audited direct task completion in JSON and Convex against OpenAPI: both
  return the completed task on repeats, as the existing contract specifies.
- JSON now returns a defensive copy after the locked reread when the task is
  already complete, avoiding state-file replacement and incidental legacy
  migration. First completion and missing-ID behavior remain unchanged.
- Two regression tests failed before the fix: legacy file-byte preservation
  and current-document inode/mtime preservation across fresh provider instances.
- `npm run check` passed: 1,189 Node tests, 227 Convex tests, TypeScript,
  ESLint, Prettier, hygiene, and zero-warning OpenAPI lint.
- Next: audit assistant-state validation and provider parity, then review
  Phase 1 coverage before advancing to persistence hardening in Phase 2.

## Phase 1 progress (2026-09-10)

- Duplicate task/reminder ID rejection was already committed in `eaf625e`;
  the Phase 0 next-step entry below has been reconciled with that code.
- Added finite creation-timestamp validation for JSON tasks and reminders in
  unversioned, v1, and v2 documents. Missing legacy timestamps still default
  to zero; finite timestamps, including zero and negative values, are retained.
- Eight regression tests cover non-finite values, finite-value compatibility,
  and real-file `1e400` overflow quarantine with exact-byte preservation and
  successful writes after recovery. Seven tests failed before implementation.
- `npm run check` passed: 1,187 Node tests, 227 Convex tests, TypeScript,
  ESLint, Prettier, hygiene, and zero-warning OpenAPI lint. Backup round-trip
  and legacy migration tests remain green.
- Next: audit repeated task completion semantics, then assistant-state
  validation and parity between providers before entering Phase 2.

## Phase 0 baseline refresh (2026-09-09)

- Inspected the root README, TypeScript structure, package scripts, strict
  compiler configuration, architecture/operator docs, OpenAPI paths, recent
  commits, and open GitHub issues. Runtime is Node 24.20.0 (`.nvmrc`: 24).
- The checkout remote is `Benny3840RG/Jarvis`; the requested
  `Benny3840/Jarvis` issue query returned no open issues. The checkout remote
  has eight open commissioning issues (#293, #294, #297, #302, #303, #306,
  #307, #324), plus PR #480.
- `npm ci` passed (318 packages installed). npm reported one moderate and
  one high dependency vulnerability; advisory triage remains outstanding.
- `npm run check` passed: hygiene, both TypeScript projects, ESLint,
  Prettier, zero-warning OpenAPI lint, 1,187 Node tests, and 231 Convex tests.
- The configured `dev:` Convex smoke passed core CRUD, five memory domains,
  notes, controlled task/reminder actions, external reconciliation, and quote
  lifecycle checks, including cleanup. No deployment sync was performed.
- Existing orchestration/isolated-ingress changes were present at session
  start and are outside this baseline commit. Checks exercise the working
  tree, including that work; they do not establish its deployment readiness.
- Core persistence already has explicit provider types, document validation,
  atomic JSON writes and locking, due normalization, and backup versioning.
  No TODO/FIXME markers were found in `src/`, `convex/`, or `tests/`.
- Known gaps: business-domain backup coverage and memory-restore atomicity
  remain as documented below. `docs/operators/http-api.md` still says no
  execution route exists although OpenAPI exposes tool-action execution;
  reconcile that documentation during the adapter audit.

### Ordered build sequence

1. Phase 1: duplicate-ID rejection is implemented. Continue with completion
   semantics and assistant-state/provider parity after timestamp validation.
2. Phase 2: verify shared provider semantics, JSON lock/recovery failure paths,
   and Convex authentication/owner isolation without replacing working code.
3. Phase 3: audit CLI flag parsing and error/no-partial-write coverage.
4. Phase 4: reconcile operator documentation, OpenAPI, HTTP, and MCP behavior
   with contract-first changes and zero-warning lint.
5. Phase 5: extend backup coverage using consistent cross-domain ID remapping
   and harden rollback for the existing memory-domain restore.
6. Phase 6: audit structured logging, destructive-operation guards, and budgets.
7. Phase 7: triage dependency advisories, remaining debt, and CI gate coverage.

Earlier session history follows; its backup priorities do not override this
phase order.

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

## This session's work

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

1. **Phase 2 of backup coverage: the cross-referenced business domains.**
   Clients, quotes, invoices, projects, properties, enquiries, and errands
   are NOT in the backup archive. These are harder than phase 1: they're
   densely cross-referenced by id (a quote holds `clientId`; an invoice holds
   `quoteId` and `clientId`; a project can hold both). Restoring them safely
   needs ONE consistent id-remap table applied across every domain at once
   (extending the existing `remapIds` helper in `backup.ts`, which today only
   remaps ids inside `assistantState`), not a per-domain copy loop. Recommend
   tackling this as its own session: map the full foreign-key graph first
   (grep each domain's type for `clientId`/`quoteId`/`projectId`/etc.), then
   design the remap order (restore in dependency order: clients before
   quotes/projects/properties/enquiries, quotes before invoices, etc.)
   before writing any restore code.
2. **Quote delivery / PDF artifact backup.** `quoteDeliveries` (Convex-only,
   see `src/persistence/convexQuoteDeliveries.ts`) and
   `quotePdfArtifactRepository` are also outside backup's reach. These are
   lower priority than the core business records above since they're
   regenerable/re-derivable (a delivery ledger, a rendered PDF) rather than
   the only copy of user-entered data — but worth a note once phase 2 lands.
3. **`personalTraitsService.ts` dead code.** `addNote` and `priorityRank` on
   `PersonalTraitsService` (`src/runtime/personalTraitsService.ts`) are
   unused anywhere in the codebase or tests (only `dailyBrief`/`motivation`
   are wired into `cli.ts`). Low priority cleanup: delete them, or wire them
   up if they were meant to ship.
4. **Convex test coverage measurement.** `npm run test:coverage` only
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
