# Reconciliation Operator Read Model Design

## Purpose

Give Jarvis operators a truthful, owner-scoped view of external side-effect reconciliation without exposing execution authority or sensitive correlation internals.

## Scope

The slice adds read-only list and detail endpoints over the existing `externalReconciliations` and durable receipt records. It does not add resend, retry, claim, resolve, release, cleanup, quote-send, approval, or deployment controls. The Console HUD is deferred until PR #246 clears the shared widget files.

## Architecture

Convex remains authoritative. A dedicated `ExternalReconciliationReadStore` exposes only `list` and `get`; the existing worker store retains mutation capabilities. The Convex query uses existing owner/state indexes and bounded `.take(limit)` reads. HTTP maps records into an operator response that omits owner IDs, execution/idempotency keys, fingerprints, receipt keys, lease owners/tokens, and raw output digests.

## Contract

- `GET /api/v1/reconciliations?state=<state>&limit=<1..100>`
- `GET /api/v1/reconciliations/:reconciliationId`
- State is optional and limited to `observing|pending|claimed|resolved|escalated`.
- Default limit is 50; maximum is 100.
- Missing and cross-owner detail reads return the same 404 problem.
- JSON-mode or uncommissioned Convex read access returns an explicit 503.
- List ordering is newest `updatedAt` first within the selected bounded query.
- Responses expose operational identity, provider references, state, attempts, terminal/error/escalation facts, timestamps, and a sanitised receipt summary.

## Failure and security rules

- Service-token authentication remains the outer HTTP guard.
- Convex derives the owner from the configured service token; callers cannot supply an owner ID.
- Unavailable persistence never becomes an empty successful list.
- No endpoint mutates records or drives the worker.
- Sensitive replay and concurrency fields never leave the server.
- A resolved provider result is not inferred from timestamps; stored state and receipt status are returned as-is.
