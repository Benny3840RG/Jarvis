# Runtime Reconciliation Host Design

**Date:** 2026-07-27  
**Status:** Approved for repository implementation  
**Scope:** Local HTTP and controlled preview runtimes only

## Objective

Run Jarvis's already-commissioned external reconciliation worker continuously inside the maintained local HTTP and controlled preview processes, without activating any external action family or introducing another persistence, queue, or scheduling system.

## Verified baseline

- `ReconciliationWorker` implements provider lookup, bounded retry delay, terminal resolution, release, and escalation.
- `ReconciliationScheduler` prevents overlapping cycles and bounds each cycle by `maxBatchSize`.
- `ConvexExternalReconciliationStore` persists claims and resolutions through authenticated Convex functions.
- `start:http` enters through `typescript/src/http/main.ts`.
- `start:preview` enters through `typescript/src/preview/main.ts`.
- The development reconciliation boundary is commissioned, but neither maintained process currently starts its scheduler.
- No provider-specific sending implementation is active.
- Production deployment remains prohibited without separate approval.

## Approaches considered

### 1. Shared process host — selected

Add one focused lifecycle component that resolves configuration, constructs the existing store/worker/scheduler, owns one abort controller, exposes an immutable health snapshot, and stops cleanly. Both maintained entrypoints use the same component.

This adds the missing process wiring while preserving every existing reconciliation boundary.

### 2. Convex scheduled function

Rejected for this slice. The existing provider adapters are Node-side and the commissioned worker already owns leases, retry and reconciliation semantics. Recreating them in Convex would duplicate the architecture.

### 3. Separate daemon

Rejected for now. It would create a second deployable process and new operational failure modes when the maintained HTTP/preview processes can host the bounded loop directly.

## Architecture

Create a `RuntimeReconciliationHost` boundary under `typescript/src/reconciliation/`.

It has four responsibilities:

1. Resolve and validate runtime configuration.
2. Construct the existing `ConvexExternalReconciliationStore`, `ReconciliationWorker`, and `ReconciliationScheduler`.
3. Start no more than one scheduler loop per host instance.
4. Record process-local health and stop the loop using cancellation.

The host does not change reconciliation records, retry rules, provider outcomes, lease semantics, or action activation. Those remain owned by existing components.

## Configuration

The host is disabled unless `JARVIS_RECONCILIATION_ENABLED=true`.

When disabled:

- no Convex client or store is constructed;
- no polling starts;
- runtime startup remains compatible with JSON persistence and existing local workflows;
- health reports `disabled`.

When enabled, configuration must fail closed before the HTTP listener is treated as ready:

| Variable | Default | Rule |
| --- | ---: | --- |
| `JARVIS_RECONCILIATION_ENABLED` | `false` | Only `true` or `false` accepted |
| `JARVIS_RECONCILIATION_WORKER_ID` | generated process identity | Non-empty safe identifier |
| `JARVIS_RECONCILIATION_LEASE_MS` | `30000` | Positive safe integer |
| `JARVIS_RECONCILIATION_INTERVAL_MS` | `5000` | Positive safe integer |
| `JARVIS_RECONCILIATION_BATCH_SIZE` | `10` | Integer from 1 through 100 |
| `JARVIS_RECONCILIATION_MAX_ATTEMPTS` | `5` | Integer from 1 through 100 |
| `JARVIS_RECONCILIATION_BASE_RETRY_MS` | `1000` | Positive safe integer |
| `JARVIS_RECONCILIATION_MAX_RETRY_MS` | `60000` | Positive safe integer and not below base retry |

Enabled mode also requires the existing Convex URL/deployment and `JARVIS_SERVICE_TOKEN` prerequisites. Missing provider adapters do not make startup fail: unknown providers remain indeterminate and follow the existing escalation path.

## Lifecycle and data flow

1. The entrypoint loads its existing environment.
2. The host factory validates reconciliation configuration.
3. Disabled mode returns a non-running host.
4. Enabled mode constructs the existing store, registry, worker, and scheduler.
5. The entrypoint starts the HTTP application.
6. The host starts exactly one background scheduler loop.
7. Each cycle claims at most the configured batch size using existing leases.
8. Provider results flow through the existing resolve/release/escalate paths.
9. `SIGINT` or `SIGTERM` aborts polling, waits for the active reconciliation call to return, then closes HTTP/MCP resources.
10. A scheduler failure changes health to `degraded`, records a redacted stable error code, and stops that loop. It never reports healthy or silently restarts in a tight loop.

## Health contract

Public `GET /healthz` remains liveness-only and does not touch persistence.

Authenticated `GET /api/v1/status` adds a `reconciliation` object sourced from the process-local host snapshot:

- `state`: `disabled | starting | running | stopping | stopped | degraded`
- `enabled`: boolean
- `workerId`: present only while enabled
- `startedAt`: ISO timestamp when the loop starts
- `lastCycleStartedAt`: ISO timestamp when a cycle starts
- `lastCycleCompletedAt`: ISO timestamp when a cycle finishes
- `lastCycleProcessed`: bounded integer
- `lastErrorCode`: redacted stable code when degraded

Health contains no service token, provider reference, reconciliation identifier, stack trace, or raw exception text.

## Error and recovery behaviour

- Invalid enabled configuration prevents runtime startup.
- Duplicate `start()` calls are idempotent and cannot create another loop.
- `stop()` is idempotent.
- Cancellation prevents new claims and waits for the in-flight provider reconciliation to settle.
- A process crash relies on the existing lease-expiry recovery path.
- Unknown providers remain unresolved and auditable; the host never retries the original external effect.
- Runtime restart creates a new worker identity unless an explicit safe worker ID is configured.
- Scheduler failure is operator-visible through authenticated status and process logging using redacted error classification.

## HTTP integration

The HTTP app receives a read-only health provider through dependency injection. Tests can inject deterministic snapshots without starting a worker or contacting Convex.

Both `src/http/main.ts` and `src/preview/main.ts` construct and own the host. Preview shutdown order is:

1. stop reconciliation claims and wait for the active call;
2. close MCP;
3. close HTTP.

If MCP startup fails, the host and HTTP app are both stopped before the error escapes.

## Testing

Test-first coverage must include:

- disabled configuration and no store construction;
- invalid booleans, bounds, retry ordering and missing enabled prerequisites;
- one loop only under repeated start calls;
- bounded cycles using the existing scheduler;
- degraded health after scheduler failure with no raw secret/error leakage;
- graceful stop while sleeping;
- graceful stop during an active provider call;
- restart recovery delegated to the existing lease behaviour;
- `/healthz` remaining persistence-free and unchanged;
- authenticated status snapshots for disabled, running and degraded states;
- HTTP-only and preview entrypoint lifecycle wiring;
- OpenAPI/runtime contract alignment;
- full repository checks.

## Acceptance criteria

- The maintained HTTP and preview processes can run the existing reconciliation scheduler when explicitly enabled.
- Disabled mode preserves current startup behaviour and performs no reconciliation I/O.
- One process host creates no more than one scheduler loop.
- Polling and batch size are bounded.
- Shutdown stops new claims and waits for active work without abandoning a newly claimed record.
- Failures are visible and redacted.
- Public liveness semantics remain unchanged.
- Authenticated status truthfully reports reconciliation state.
- Existing action families remain planned.
- No live email/calendar action, provider activation, Convex production deployment, or Manufact production deployment occurs.
