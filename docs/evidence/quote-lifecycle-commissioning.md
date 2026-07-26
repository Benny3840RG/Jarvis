# Quote Lifecycle — Development Commissioning Evidence

## Disposition

The revision-safe quote lifecycle and its provider-neutral delivery ledger, built across Tasks 1-9 of `docs/superpowers/plans/2026-07-24-quote-lifecycle.md`, are commissioned on the authorised Convex development deployment.

This record does not activate `AM-012 Finalize quote` or `AM-013 Send quote`, does not exercise any live email provider, and does not authorise or record a production deployment.

## Verified revisions

- Runtime implementation merges: PR #205 (Task 6, delivery ledger), #206 (Task 5, finalisation tool boundary), #207 (Task 7, legacy migration), #208 (Task 8, dev-only cleanup + lifecycle smoke)
- Governance traceability merge: PR #210 (Task 9)
- Commissioning source (exact head): `4bad125dd9a6b8874e283767f332ce84934a5035` (PR #211 merge to `main`)
- Guarded development commissioning workflow: `.github/workflows/development-commissioning.yml`
- Guarded development commissioning run: `30196857042`
- Guarded development commissioning job: `89779781775`
- No separate evidence-packaging workflow or retained artifact exists for this tranche — unlike the #154 external-reconciliation evidence, this reuses the existing generic commissioning workflow as-is rather than building a bespoke one-shot workflow (it already covers the quote lifecycle smoke via `npm run smoke:convex`), so there is no uploaded artifact ID, name, or digest to record. Evidence here is the workflow run/job IDs above plus the log excerpts quoted below.

## Authorised target

- Deployment: `dev:outgoing-ram-798`
- URL: `https://outgoing-ram-798.convex.cloud`
- Production deployment: **not authorised and not performed**

## Passed gates

- Locked dependency installation and complete `npm run check` (654 node:test + 38 convex-test)
- Convex function sync using `npx convex dev --once --tail-logs disable`, which added the quote delivery/migration indexes to the live dev schema (`quoteDeliveryAttempts.by_owner_and_delivery_attempt_id`, `by_owner_and_reconciliation_id`, `by_owner_and_send_scope`, `by_owner_and_status`, `by_owner_quote_and_revision`; `quoteMigrationRecords.by_owner_and_source_key`)
- Self-cleaning Convex smoke suite (`npm run smoke:convex`), including the quote lifecycle smoke added in Task 8 — job log: `Convex smoke passed for quote lifecycle: creation, review, finalization, immutability, forking, delivery ledger and cleanup.`
- HTTP health check and authenticated `/api/v1/status` (persistence provider `convex`, reachable, authenticated, schema-compatible, deployment `dev:outgoing-ram-798`)
- Totality reasoning boundary probe (`/api/v1/totality/reason`) completed without proposing any tool actions
- Development backup export and isolated verification (`1 task(s), 1 reminder(s)` — job log: `Backup verified in isolated storage: 1 task(s), 1 reminder(s), assistant state restored.`)

## Preserved boundaries

- `AM-012 Finalize quote` remains `lifecycle_status: planned`.
- `AM-013 Send quote` remains `lifecycle_status: planned`.
- `TOOL-QUOTE-FINALIZE` and `TOOL-QUOTE-SEND` are not in the live tool-execution allowlist (`tests/quoteAllowlistBoundary.test.ts` asserts this structurally).
- No provider-specific send implementation is active — `createQuoteEmailProviderFromEnv` still always returns `null`.
- No external action family was activated by this commissioning tranche.
- Live Outlook (or any other) provider selection/activation requires a separate, explicitly approved tranche.
