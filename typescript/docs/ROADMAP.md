# Jarvis TypeScript Roadmap

This file is a living record for the autonomous engineering sessions working on
Jarvis: current state, what changed recently, and what to pick up next. Update
it at the end of every session.

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

## Archive v4 manifest review (2026-09-10)

- S1 adds strict manifest parsing, coverage metadata and SHA-256 digest format
  validation. Full recovery reparses the manifest and refuses forged completeness.
- Every manifest remains partial until a real restore verifier is implemented;
  group presence and reference descriptions do not prove recovery integrity.
- Next: S2 core/memory capture and isolated restore, then S3 business records
  and settings; complete recovery remains gated on the later domain/verifier work.

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

1. **Phase 2 of backup coverage: the cross-referenced business domains.**
   Clients, quotes, invoices, projects, properties, enquiries, and errands
   are NOT in the backup archive. These are harder than phase 1: they're
   densely cross-referenced by id (a quote holds `clientId`; an invoice holds
   `quoteId` and `clientId`; a project can hold both). Restoring them safely
   needs the explicit reference inventory in
   [the v4 contract](architecture/backup-v4-contract.md): preserve logical IDs
   in an empty destination and translate platform-generated IDs, including
   string-typed references, with table-scoped maps. Existing `add()` APIs do
   not necessarily preserve IDs. Verify the complete reference graph rather
   than applying an untyped global string replacement.
2. **Quote delivery / PDF artifact backup.** The delivery-attempt/outcome ledger
   is authoritative history, including failed and indeterminate outcomes;
   re-sending cannot restore it. PDF bytes are only conditionally regenerable
   from the full aggregate/revision snapshot, stored issuer/client/generatedAt
   and pinned renderer, with a verified digest. Blob backup remains in scope.
   See the [domain inventory](architecture/authoritative-domain-inventory.md)
   and [v4 contract](architecture/backup-v4-contract.md).
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
