# External-Action Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the durable provider-facing reconciliation controls required before any external `send` or `execute` action can become active.

**Architecture:** Extend the existing tool-execution ledger rather than introducing a parallel state system. External tools durably register provider attempt references, and indeterminate outcomes atomically bind the receipt to a Convex reconciliation record. A lease-based Node worker claims due records, queries a provider adapter, and atomically resolves the receipt or reschedules/escalates the record without blind retry.

**Tech Stack:** TypeScript, Zod, Convex, Node test runner, GitHub Actions.

## Global Constraints

- Development only; no Convex or Manufact production deployment.
- Keep all external action families, including `AM-013 Send quote`, planned.
- Existing internal tool behaviour and receipt replay must remain compatible.
- A timed-out external action must produce one durable indeterminate receipt and one durable reconciliation record.
- Provider request and correlation references must be persisted before an external attempt can be treated as safely recoverable.
- A duplicate external request with the same scoped idempotency key must return the original outcome or reject a changed effect; it must never execute the provider again while reconciliation is unresolved.
- Claim and resolution transitions must be atomic and exactly once under concurrent workers.
- Unresolved provider status remains indeterminate and auditable; repeated uncertainty eventually escalates rather than retrying the original external effect.
- No provider-specific send implementation is activated by this plan.

---

### Task 1: Reconciliation domain contracts

**Files:**
- Create: `typescript/src/reconciliation/externalReconciliation.ts`
- Modify: `typescript/src/actions/toolExecution.ts`
- Test: `typescript/tests/externalReconciliationDomain.test.ts`

**Interfaces:**
- Produce `ProviderAttemptReference`, `ExternalReconciliationRecord`, `ExternalReconciliationClaim`, `ProviderReconciliationResult`, `ProviderReconciliationAdapter`, and `ExternalReconciliationStore`.
- Produce `fingerprintToolEffect(action)` separately from the approval-bound action fingerprint.
- Extend `ToolExecutionContext` with `registerProviderAttempt(reference)` for external definitions.

- [x] Define explicit reconciliation states: `observing`, `pending`, `claimed`, `resolved`, and `escalated`.
- [x] Define terminal provider outcomes: `succeeded` and `failed`; define `unresolved` as a non-terminal worker result.
- [x] Define a stable owner/project/tool/operation/idempotency scope independent of `actionId`.
- [x] Test same-effect duplicate detection and changed-effect collision detection.

### Task 2: Durable Convex ledger and lease transitions

**Files:**
- Create: `typescript/convex/externalReconciliationValidators.ts`
- Create: `typescript/convex/externalReconciliations.ts`
- Modify: `typescript/convex/schema.ts`
- Modify: `typescript/convex/toolExecutionValidators.ts`

**Interfaces:**
- `registerAttempt`: idempotently persist provider and correlation references by external execution scope.
- `markIndeterminate`: atomically save/update the indeterminate receipt and move the reconciliation record to `pending` or `escalated` when a provider request reference is unavailable.
- `claimNext`: claim one due or expired-lease record with a caller-supplied lease token.
- `resolveClaim`: atomically resolve a valid claim and update the authoritative receipt to `succeeded` or `failed`.
- `releaseClaim`: reschedule unresolved provider status or escalate after the configured attempt ceiling.
- `cleanup`: authenticated development-only cleanup for commissioning evidence.

- [x] Add indexes for scope uniqueness, due pending work, expired claims, receipt binding, and auditable status listing.
- [x] Use indexed `.take(1)`/`.unique()` queries only; do not add unbounded scans.
- [x] Reject fingerprint or provider-reference collisions.
- [x] Prove stale lease tokens cannot resolve or release another worker's claim.

### Task 3: Convex reconciliation adapter

**Files:**
- Create: `typescript/src/persistence/convexExternalReconciliations.ts`

**Interfaces:**
- Implement every `ExternalReconciliationStore` method through authenticated generated Convex references.
- Map epoch millisecond fields to domain records without losing optional provider or resolution metadata.

- [x] Verify service-token enforcement through the Convex function boundary.
- [x] Preserve exact scope, receipt, provider-reference, lease and resolution arguments.
- [x] Preserve null and collision responses without inventing state.

### Task 4: External execution integration and blind-retry block

**Files:**
- Modify: `typescript/src/actions/toolExecution.ts`

**Interfaces:**
- External tool definitions declare `externalProvider`.
- `registerProviderAttempt` durably records the provider request before the external call can become indeterminate.
- Timeout or any error after provider acceptance calls `markIndeterminate` instead of ordinary receipt `save`.
- Existing unresolved scope returns the original indeterminate receipt and never calls the tool definition.
- A changed effect under the same scope returns a persisted fingerprint-mismatch block.

- [x] Keep internal definition execution unchanged.
- [x] Require an `ExternalReconciliationStore` whenever an external definition is registered.
- [x] Enforce provider-name consistency between definition and registered attempt.
- [x] Treat an external success without a registered provider reference as indeterminate/escalated, never as proven success.
- [x] Test restart replay and duplicate-action-ID suppression through the integrated suite.

### Task 5: Lease-based worker and scheduler

**Files:**
- Create: `typescript/src/reconciliation/reconciliationWorker.ts`
- Create: `typescript/src/reconciliation/reconciliationScheduler.ts`
- Test: `typescript/tests/reconciliationWorker.test.ts`
- Test: `typescript/tests/reconciliationScheduler.test.ts`

**Interfaces:**
- `ReconciliationWorker.runOnce({ workerId, leaseMs, signal })` claims at most one record.
- Provider adapters receive the durable provider request/correlation reference and an abort signal.
- `succeeded`/`failed` results resolve the claim exactly once.
- `unresolved` results release with bounded backoff; the final allowed uncertainty escalates.
- The scheduler repeatedly drains bounded batches without overlapping ticks and stops through `AbortSignal`.

- [x] Reject duplicate provider adapter registrations.
- [x] Leave unknown-provider records indeterminate and escalated with an auditable reason.
- [x] Prove concurrent workers produce one claim and one terminal resolution.
- [x] Prove expired claims are recoverable after a process restart.

### Task 6: Self-cleaning development smoke

**Files:**
- Create: `typescript/src/tools/externalReconciliationSmoke.ts`
- Modify: `typescript/src/tools/runConvexSmoke.ts`
- Test: `typescript/tests/externalReconciliationSmoke.test.ts`

**Interfaces:**
- Register a synthetic provider reference under a unique project and execution scope.
- Persist one indeterminate receipt atomically.
- Claim it from a fresh adapter instance.
- Resolve it through a deterministic fake provider adapter.
- Verify the authoritative receipt changed exactly once and cleanup removed the synthetic data.

- [x] Refuse any non-`dev:` deployment before constructing a store.
- [x] Prove restart recovery using fresh adapter instances.
- [x] Guarantee cleanup after both success and injected failure.

### Task 7: Runtime landing and commissioning evidence

**Files:**
- Create: `.github/workflows/external-reconciliation-development-commissioning.yml` only in the commissioning stage.
- Create: `docs/evidence/external-reconciliation-commissioning.md` only after the live run passes.
- Modify: `docs/superpowers/plans/2026-07-24-external-reconciliation.md`

- [ ] Merge runtime with no external action family activated.
- [ ] Sync only `dev:outgoing-ram-798` and run the full self-cleaning smoke.
- [ ] Retain run, job, artifact and digest evidence.
- [ ] Remove the one-shot commissioning workflow.
- [ ] Close issue #154 only after final CI and immutable evidence pass.
