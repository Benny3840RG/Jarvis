# External-Action Reconciliation — Development Commissioning Evidence

## Disposition

The durable external-action reconciliation subsystem (issue #154) is commissioned on the authorised Convex development deployment: a durable indeterminate-work queue, lease-based reconciliation worker and non-overlapping scheduler, a provider adapter registry, and fail-closed `ToolExecutionService` integration with no-blind-retry replay.

This is infrastructure, not an action family — it does not itself activate any `AM-###` entry. `AM-012 Finalize quote` and `AM-013 Send quote` remain `lifecycle_status: planned`; no external `send`, `execute`, or `destructive` action family is active as a result of this record.

This record does not authorise or record a Convex or Manufact production deployment.

## Verified revisions

- Runtime implementation merge: `0646b1a1f1fff13e12913259c2618d50fe334526` (PR #170)
- Development-commissioning trigger commit: `9765b0cc614e4d792cff95b98f070882ce05ef20`
- Queue-and-report workflow run: `30079569163`
- Queue job: `89437831651`
- Dispatched development-commissioning run: `30079574919`
- Commissioning job: `89437852079`
- Canonical status record: https://github.com/Benny3840/Jarvis/issues/54

## Authorised target

- Deployment: `dev:outgoing-ram-798`
- URL: `https://outgoing-ram-798.convex.cloud`
- Production deployment: **not authorised and not performed**

## Passed gates

- Locked dependency installation and complete `npm run check` (type-check, lint, format, OpenAPI lint, full test suite)
- Convex function sync using `npx convex dev --once`
- Self-cleaning Convex smoke test
- HTTP health check, authenticated status, and Totality reasoning-boundary probe
- Development backup export and isolated verification

Unlike AM-003 and the task/reminder actions, this commissioning run used the generic `development-commissioning.yml` gate rather than a dedicated live-deployment smoke script with its own uploaded artifact — there is no reconciliation-specific artifact analogous to `task-reminder-development-commissioning-*`. The reconciliation subsystem's specific behavioural guarantees are instead verified by committed, self-cleaning regression tests that ran as part of `npm run check` in the same commissioning run:

- `tests/externalReconciliationDomain.test.ts`, `tests/externalReconciliationConvexContracts.test.ts`, `tests/convexExternalReconciliations.test.ts` — domain and Convex-adapter contract coverage
- `tests/externalReconciliationSmoke.test.ts` — *"refuses non-development deployments before constructing a store"*, *"recovers from a fresh store instance, resolves once, and cleans all synthetic state"*, *"cleans synthetic reconciliation state after an injected claim failure"*
- `tests/reconciliationWorker.test.ts` — *"claims one record and resolves a proven provider success exactly once"*, *"releases unresolved provider status with bounded retry timing"*, *"escalates an unknown provider without attempting the external effect"*, *"allows concurrent workers to produce only one claim and one terminal resolution"*
- `tests/reconciliationScheduler.test.ts` — *"drains no more than the configured batch size in one cycle"*, *"skips an overlapping cycle instead of running two drains concurrently"*, *"stops the scheduling loop through AbortSignal"*
- `tests/reconciliationRestartRecovery.test.ts` — *"allows a fresh worker process to reclaim and resolve an expired lease"*
- `tests/reconciliationLeaseFreshness.test.ts` — *"uses the post-provider timestamp when resolving a claimed reconciliation"*
- `tests/reconciliationReadFailure.test.ts` — *"keeps a known effect-fingerprint collision classified as fingerprint-mismatch"*, *"classifies an arbitrary reconciliation-store outage without pretending it is a collision"*
- `tests/toolExecutionReconciliation.test.ts` — *"persists one indeterminate outcome and blocks blind retry after timeout"*, *"blocks a changed effect under the same external idempotency scope"*, *"never reports external success without a durable provider reference"*, *"atomically completes a registered external success"*
- `tests/reconciliationLeaseFreshness.test.ts` / `tests/reconciliationRestartRecovery.test.ts` between them cover every "Required tests" bullet in issue #154 except duplicate-request handling, which `tests/toolExecutionReconciliation.test.ts`'s fingerprint-scope test covers.

## Bound implementation

- `src/persistence/convexExternalReconciliations.ts` — authenticated Convex adapter (owner-scoped via `requireOwner`)
- `src/reconciliation/externalReconciliation.ts` — store interface, scope, and record types
- `src/reconciliation/reconciliationWorker.ts`, `reconciliationScheduler.ts` — lease-based claim/resolve worker and non-overlapping scheduler
- `src/actions/toolExecution.ts` — fail-closed `ToolExecutionService` integration and no-blind-retry replay
- `convex/externalReconciliations.ts`, `convex/schema.ts` — durable ledger, indexes, and lease transitions

## Preserved boundaries

- `AM-012 Finalize quote` remains planned.
- `AM-013 Send quote` remains planned.
- No action family becomes active as a result of this record; the quote revision/delivery redesign (issue #152) is still required before either can activate.
