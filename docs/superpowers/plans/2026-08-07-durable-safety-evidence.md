# Durable Safety Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the immutable six-category safety decision alongside governed action, execution, and external-reconciliation evidence across Convex restarts.

**Architecture:** Reuse the existing `bindSafety` contract and add an optional versioned `safetyBinding` object to migration-safe Convex documents. Tool-action transition audit events carry a copy for every proposal/approval/revocation/expiry transition; execution receipts carry the execution binding; external-reconciliation documents retain the binding through provider-reference, indeterminate, terminal, and worker-resolution transitions. Existing approval, idempotency, provider-reference, and reconciliation controls remain authoritative.

**Tech Stack:** TypeScript, Convex validators/mutations, `convex-test`, Node test runner.

## Global Constraints

- Preserve legacy rows: missing `safetyBinding` is accepted only as legacy evidence, never treated as proof of safety.
- Persist the six canonical categories in canonical order with stable `pass`/`blocked` statuses and deterministic reasons.
- Never persist tool arguments, prompts, credentials, raw provider errors, or provider response bodies in the binding.
- Do not activate external providers or production deployment.
- Verify restart/retrieval through Convex tests and run the complete repository gate.

---

### Task 1: Define the durable binding contract

**Files:**

- Create: `typescript/convex/safetyBindingValidators.ts`
- Modify: `typescript/src/safety/safetyBinder.ts`
- Modify: `typescript/src/actions/toolActions.ts`
- Modify: `typescript/src/actions/toolExecution.ts`
- Modify: `typescript/src/reconciliation/externalReconciliation.ts`
- Test: `typescript/tests/safetyBinder.test.ts`

- [ ] Add failing contract assertions for the version literal, canonical six-category order, deep immutability, and legacy-optional runtime fields.
- [ ] Run the focused tests and verify the new contract assertions fail on the old types.
- [x] Add the shared version/type and Convex validators, then attach optional bindings to the runtime action, receipt, and reconciliation types.
- [x] Run focused TypeScript tests and type-check.

### Task 2: Persist proposal and consent-lifecycle evidence

**Files:**

- Modify: `typescript/convex/schema.ts`
- Modify: `typescript/convex/toolActionValidators.ts`
- Modify: `typescript/convex/toolActions.ts`
- Test: `typescript/convex/toolActions.test.ts`

- [x] Add failing Convex tests proving stage, approve, expiry observation, and revoke each persist a complete binding in the action and corresponding audit event.
- [x] Run the Convex tests and verify the old schema has no binding evidence.
- [x] Compute the binding server-side at each transition, patch the current action binding, and include a copied binding in each audit payload.
- [x] Verify legacy rows remain readable and no sensitive action arguments enter safety evidence.

### Task 3: Persist execution and external-reconciliation evidence

**Files:**

- Modify: `typescript/convex/schema.ts`
- Modify: `typescript/convex/toolExecutionValidators.ts`
- Modify: `typescript/convex/externalReconciliationValidators.ts`
- Modify: `typescript/convex/toolExecutionReceipts.ts`
- Modify: `typescript/convex/externalReconciliations.ts`
- Modify: `typescript/src/persistence/convexToolExecutionReceipts.ts`
- Modify: `typescript/src/persistence/convexExternalReconciliations.ts`
- Modify: `typescript/src/actions/toolExecution.ts`
- Modify: `typescript/src/reconciliation/externalReconciliation.ts`
- Test: `typescript/convex/toolExecutionReceipts.test.ts`
- Test: `typescript/convex/externalReconciliations.test.ts`

- [x] Add failing tests proving receipts and reconciliation records retain the binding through indeterminate and terminal resolution, including a fresh read.
- [x] Run focused Convex tests and verify the old contracts drop the binding.
- [x] Add the optional validator/document fields and propagate the binding through every adapter and lifecycle mutation.
- [x] Verify legacy receipts/reconciliations remain readable without inventing safety evidence.

### Task 4: Reconcile evidence and verify the exact tree

**Files:**

- Modify: `docs/architecture/immutable-safety-category-binding.md`
- Modify: `docs/traceability/requirements-matrix.md`
- Modify: `docs/traceability/evidence-matrix.md`
- Modify: `docs/traceability/test-matrix.md`

- [x] Update the safety evidence statement to distinguish durable development evidence from live commissioning.
- [ ] Run type-check, lint, formatting, OpenAPI, all Node tests, and all Convex tests.
- [ ] Review the diff for secret/payload leakage and verify the worktree is clean except the intended branch commit.

### Task 5: Publish through protected review

- [ ] Commit the exact verified tree on a feature branch.
- [ ] Open a PR against `main` with the required review sections.
- [ ] Resolve actionable review findings, rerun exact-head gates, and request per-PR landing confirmation before merge.
