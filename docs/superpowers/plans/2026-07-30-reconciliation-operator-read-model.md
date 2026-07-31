# Reconciliation Operator Read Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded, owner-scoped and sanitised read-only API for external reconciliation records and durable receipts.

**Architecture:** Add separate read interfaces and Convex queries over additive owner/update-time indexes, then inject the read store into a narrow Nest controller. Keep worker mutations inaccessible and defer HUD wiring until PR #246 lands.

**Tech Stack:** TypeScript, Convex, NestJS/Fastify, Vitest, node:test, OpenAPI 3.

## Global Constraints

- No external side effects or reconciliation mutations.
- No new table. Two additive Convex indexes are permitted for bounded newest-first operator reads: `by_owner_and_updated_at` and `by_owner_and_state_and_updated_at`.
- All Convex functions use object form with args and returns validators.
- Every list read is owner-scoped, indexed and bounded to at most 100 records.
- HTTP responses omit execution keys, idempotency keys, fingerprints, receipt keys, lease data and output digests.
- JSON/uncommissioned mode returns explicit 503, never counterfeit empty data.
- HUD files remain untouched while PR #246 is active.

---

### Task 1: Convex read contract

**Files:**
- Modify: `typescript/convex/externalReconciliations.ts`
- Modify: `typescript/convex/externalReconciliations.test.ts`
- Modify: `typescript/convex/schema.ts`

**Interfaces:**
- Produces: `listForOperator({serviceToken,state?,limit?})` and `getForOperator({serviceToken,reconciliationId})`, returning reconciliation plus optional receipt.

- [x] Write failing tests proving owner isolation, state filtering, descending update order, a maximum limit of 100, and same null result for absent/cross-owner detail.
- [x] Run `cd typescript && npx vitest run convex/externalReconciliations.test.ts`; expect missing generated functions/indexes.
- [x] Add additive owner/update-time indexes for bounded newest-first operator reads.
- [x] Implement the two queries with `by_owner_and_state_and_updated_at` for filtered lists and `by_owner_and_updated_at` for unfiltered lists.
- [x] Run the focused Convex test; expect pass.
- [x] Commit the Convex read contract.

### Task 2: Read-store adapter

**Files:**
- Modify: `typescript/src/reconciliation/externalReconciliation.ts`
- Modify: `typescript/src/persistence/convexExternalReconciliations.ts`
- Modify: `typescript/tests/convexExternalReconciliations.test.ts`

**Interfaces:**
- Produces: `ExternalReconciliationReadStore.listForOperator(input)` and `.getForOperator(reconciliationId)`.
- Consumes: Task 1 Convex queries.

- [x] Write failing adapter tests for argument mapping and timestamp/receipt conversion.
- [x] Run `cd typescript && node --import tsx --test tests/convexExternalReconciliations.test.ts`; expect missing methods.
- [x] Add a read-only interface and implement it on `ConvexExternalReconciliationStore`.
- [x] Run focused tests; expect pass.
- [x] Commit the adapter.

### Task 3: Sanitised HTTP endpoints

**Files:**
- Create: `typescript/src/http/reconciliationController.ts`
- Modify: `typescript/src/http/reconciliationRequest.ts`
- Modify: `typescript/src/http/tokens.ts`
- Modify: `typescript/src/http/jarvisHttpModule.ts`
- Modify: `typescript/src/http/app.ts`
- Create: `typescript/tests/reconciliationHttp.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/reconciliations` and `GET /api/v1/reconciliations/:reconciliationId`.
- Consumes: `ExternalReconciliationReadStore`.

- [x] Write failing HTTP tests for auth, validation, 503, 404 parity, list/detail shape, and forbidden sensitive fields.
- [x] Run `cd typescript && node --import tsx --test tests/reconciliationHttp.test.ts`; expect route 404.
- [x] Implement strict query parsing, sanitised response mapping, controller registration and injected/read-from-environment store selection.
- [x] Run focused HTTP tests; expect pass.
- [x] Commit the HTTP contract.

### Task 4: OpenAPI and repository gates

**Files:**
- Modify: `typescript/openapi/jarvis.openapi.json`
- Modify: `typescript/tests/httpOpenApiRouteAlignment.test.ts` only if the existing route enumerator needs a live-shaped injected read store.
- Modify: affected operator documentation found by repository search.

**Interfaces:**
- Produces: declared operation IDs and schemas matching Task 3.

- [x] Add OpenAPI paths, query validators, record/receipt schemas and 401/404/422/503 responses.
- [x] Run `cd typescript && npm run check`.
- [x] Run route/OpenAPI alignment, governance, dependency audit and Console build gates.
- [x] Inspect the exact diff for sensitive-field leaks and mutation reachability.
- [x] Update PR evidence and request independent exact-head review.
