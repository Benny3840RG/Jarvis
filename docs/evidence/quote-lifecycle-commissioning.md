# Quote Lifecycle — Development Commissioning Evidence

## Disposition

The revision-safe quote lifecycle and its provider-neutral delivery ledger, built across Tasks 1-9 of `docs/superpowers/plans/2026-07-24-quote-lifecycle.md`, are commissioned on the authorised Convex development deployment.

This is the historical provider-neutral commissioning record for the quote lifecycle ledger and finalisation boundary. The later AM-012 activation is recorded separately by PR #292 and the current guarded commissioning run; this document still does not exercise a live email provider or authorise a production deployment.

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

## Current activation record

- AM-012 `Finalize quote` is now `lifecycle_status: active` and was separately activated and verified by PR #292 on source `211e7163a084c2af8db7ac4e10f1dafe2bc2f7ac`.
- The guarded commissioning run for that current source is `30956407980`; it proved the AM-012 finalisation allowlist boundary on the authorised development deployment.
- AM-013 `Send quote` remains `lifecycle_status: planned`; no live Outlook credential, draft, send, or reconciliation run is evidenced.
- `TOOL-QUOTE-FINALIZE` is available only within the approved AM-012 boundary. `TOOL-QUOTE-SEND` remains unavailable.
- `createQuoteEmailProviderFromEnv` remains disabled unless the explicit Outlook configuration is present; its configured path is not live commissioning evidence.
- Production deployment and public email sending remain unauthorised.
