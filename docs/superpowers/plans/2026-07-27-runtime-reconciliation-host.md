# Runtime Reconciliation Host Implementation Plan

**Date:** 2026-07-27  
**Design:** `docs/superpowers/specs/2026-07-27-runtime-reconciliation-host-design.md`  
**Branch:** `feat/runtime-reconciliation-host`

## Objective

Wire the existing external reconciliation scheduler into the maintained HTTP and preview processes behind disabled-by-default, fail-closed configuration, with redacted process-local health and graceful shutdown.

## Guardrails

- Extend the existing store, worker and scheduler; create no second queue or state machine.
- Do not activate provider adapters or external effects.
- Do not deploy Convex, Manufact or any production runtime.
- Keep `GET /healthz` liveness-only.
- Expose reconciliation state only through authenticated `GET /api/v1/status`.
- Validate all enabled configuration before a listener is considered ready.
- Preserve bounded batches, leases, indeterminate outcomes and existing retry semantics.

## Task 1 — Lock configuration behaviour with failing tests

**Files**
- Create `typescript/tests/runtimeReconciliationHost.test.ts`

**Cases**
- Disabled by default and for explicit `false`.
- Reject all other boolean spellings.
- Validate safe positive integer fields, batch/attempt bounds and retry ordering.
- Require Convex URL/deployment and service token only when enabled.
- Prove disabled construction performs no Convex/store I/O.

**Validation**
- Targeted Node test must fail because the host module does not yet exist.

## Task 2 — Implement configuration and host lifecycle

**Files**
- Create `typescript/src/reconciliation/runtimeReconciliationHost.ts`

**Responsibilities**
- Parse an injected environment map.
- Produce a discriminated disabled/enabled configuration.
- Construct the existing Convex store, provider registry, worker and scheduler through injectable factories.
- Generate a safe per-process worker identity when none is supplied.
- Make repeated `start()` and `stop()` calls idempotent.
- Own one abort controller and one loop promise.
- Await active reconciliation work during shutdown.
- Convert loop failure to a redacted stable health code and `degraded` state.

**Validation**
- Configuration tests green.
- Lifecycle tests prove one loop, sleeping cancellation, active-call shutdown and degraded redaction.

## Task 3 — Add truthful scheduler cycle observation

**Files**
- Update `typescript/src/reconciliation/reconciliationScheduler.ts`
- Update/create scheduler tests as required.

**Change**
- Add an optional cycle observer or equivalent narrow callback contract so the host can record cycle start, completion and bounded processed count without duplicating the scheduler loop.

**Invariants**
- Existing callers and retry behaviour remain unchanged.
- Observer failure cannot corrupt claims or convert reconciliation outcomes.
- No overlapping cycles.

**Validation**
- Existing scheduler tests remain green.
- New observer tests cover success, skip and failure.

## Task 4 — Inject reconciliation health into authenticated status

**Files**
- Update the HTTP application/composition module identified during implementation.
- Update `typescript/tests/http.test.ts`.
- Update `typescript/openapi/jarvis.openapi.json`.
- Update `typescript/docs/operators/http-api.md`.

**Contract**
- Add `reconciliation` to authenticated status with states:
  `disabled | starting | running | stopping | stopped | degraded`.
- Include only the fields approved in the design.
- Omit worker identity when disabled.
- Never expose tokens, provider references, record IDs, raw errors or stacks.
- Leave `/healthz` response and persistence behaviour unchanged.

**Validation**
- Disabled, running and degraded status snapshots.
- Authentication remains required.
- OpenAPI lint and runtime-contract tests pass.

## Task 5 — Wire maintained process entrypoints

**Files**
- Update `typescript/src/http/main.ts`.
- Update `typescript/src/preview/main.ts`.
- Add focused entrypoint/lifecycle tests or extract testable composition helpers.

**Order**
1. Load and validate configuration.
2. Construct HTTP/MCP resources.
3. Start listeners.
4. Start the reconciliation host.
5. On signal: stop reconciliation, then close MCP, then close HTTP.
6. On partial startup failure: stop every resource already started before rethrowing.

**Validation**
- HTTP-only startup/shutdown test.
- Preview startup/shutdown and MCP-start failure test.
- Disabled mode proves no reconciliation dependency is touched.

## Task 6 — Operator documentation and full verification

**Files**
- Update `docs/deployment.md` and preview/operator documentation only where runtime configuration is relevant.
- Record implementation evidence in the PR description.

**Commands**
- `npm ci`
- `npm audit`
- `npm run type-check`
- `npm run lint`
- `npm run format:check`
- `npm run openapi:lint`
- `npm run test:coverage`
- Jarvis Console 01 build/type-check
- Required GitHub workflows and review-thread check

## Completion gate

The slice is complete only when disabled mode is backward-compatible, enabled configuration fails closed, one loop is proven, shutdown waits for active work, health is authenticated and redacted, full CI is green, and no provider or production deployment has been activated.
