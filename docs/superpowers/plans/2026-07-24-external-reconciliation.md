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

## Runtime verification

- Runtime implementation branch: `feat/external-reconciliation-154`
- Runtime PR: `#170`
- Implemented files include the Convex ledger, authenticated adapter, execution integration, worker, scheduler and development smoke.
- Tests cover effect collisions, replay suppression, lease ownership, worker concurrency, unknown providers, scheduler overlap and smoke cleanup.
- All external action families remain planned until separate commissioning evidence and governance activation.

---

### Task 1: Reconciliation domain contracts

- [x] Define explicit reconciliation states: `observing`, `pending`, `claimed`, `resolved`, and `escalated`.
- [x] Define terminal provider outcomes: `succeeded` and `failed`; define `unresolved` as a non-terminal worker result.
- [x] Define a stable owner/project/tool/operation/idempotency scope independent of `actionId`.
- [x] Test same-effect duplicate detection and changed-effect collision detection.

### Task 2: Durable Convex ledger and lease transitions

- [x] Add indexes for scope uniqueness, due pending work, expired claims, receipt binding, and auditable status listing.
- [x] Use indexed queries only; do not add unbounded scans.
- [x] Reject fingerprint or provider-reference collisions.
- [x] Prove stale lease tokens cannot resolve or release another worker's claim.

### Task 3: Convex reconciliation adapter

- [x] Enforce service-token authentication through every Convex function boundary.
- [x] Preserve exact scope, receipt, provider-reference, lease and resolution arguments.
- [x] Preserve null and collision responses without inventing state.

### Task 4: External execution integration and blind-retry block

- [x] Keep internal definition execution unchanged.
- [x] Require an `ExternalReconciliationStore` whenever an external definition is registered.
- [x] Enforce provider-name consistency between definition and registered attempt.
- [x] Treat external success without a registered provider reference as indeterminate/escalated, never as proven success.
- [x] Test restart replay and duplicate-action-ID suppression through the integrated suite.

### Task 5: Lease-based worker and scheduler

- [x] Reject duplicate provider adapter registrations.
- [x] Leave unknown-provider records indeterminate and escalated with an auditable reason.
- [x] Prove concurrent workers produce one claim and one terminal resolution.
- [x] Prove expired claims are recoverable after a process restart.
- [x] Prevent overlapping scheduler cycles and bound each drain batch.

### Task 6: Self-cleaning development smoke

- [x] Refuse any non-`dev:` deployment before constructing a store.
- [x] Prove restart recovery using fresh adapter instances.
- [x] Guarantee cleanup after both success and injected failure.

### Task 7: Runtime landing and commissioning evidence

- [ ] Merge runtime with no external action family activated.
- [ ] Sync only `dev:outgoing-ram-798` and run the full self-cleaning smoke.
- [ ] Retain run, job, artifact and digest evidence.
- [ ] Remove the one-shot commissioning workflow.
- [ ] Close issue #154 only after final CI and immutable evidence pass.

## Final runtime checkpoint

The runtime tranche is complete when the exact PR head passes the permanent TypeScript workflow and review-thread inspection. Commissioning begins only after that exact head is merged; no external action family becomes active during this runtime merge.
