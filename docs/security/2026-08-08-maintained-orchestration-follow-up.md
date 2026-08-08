# Maintained Orchestration and Dependency Follow-up — 2026-08-08

## Verified changes

The following changes are now on main at 0485ba750c9f08735ab784a1a3877c84d345144d:

- PR #321 refreshed js-yaml, nanoid, and console dompurify to audited versions.
- The exact-head dependency repair checks passed npm audit for both TypeScript workspaces.
- PR #320 added deterministic weighted dependency ordering to the maintained orchestration graph.
- PR #320 added trigger envelope validation and an in-process trigger registry.
- PR #320 added maximum-step and maximum-duration budgets to the maintained runner.
- Budget exhaustion is recorded as execution_budget_exceeded before the next effect boundary, while completed-step evidence is retained.
- PR #325 verifies provider-neutral run/step state semantics: idempotent replay/conflict handling, legal completion closure, and indeterminate outcomes that cannot be blindly retried.
- The exact-head orchestration checks passed typecheck, lint, formatting, OpenAPI validation, Node/Convex tests, console build/typecheck, and automation policy.

## Scope boundary

This is a maintained offline foundation, not a production commissioning claim. The runner is not yet composed with Convex-backed durable run/step state, a production trigger ingress, authorization policy binding, persistent idempotency storage, checkpoint/resume, compensation, or governed HTTP/MCP activation. Existing live blockers remain:

- Outlook OAuth and quote delivery proof: issues #293, #294, and #297.
- PostHog ingestion proof: issue #302.
- OIDC and remote gateway commissioning: issue #306.
- Production hosting, backup/restore, rotation, restart, rollback, and deployment approval: issue #307.
- Full local whole-repository security scanning remains unavailable in the connector-only environment.

## Next gate

The next P4 orchestration slice must implement the Convex persistence adapter for the verified state contract, bind trigger idempotency to storage, and prove restart/recovery semantics before any CLI, scheduler, HTTP, or MCP activation. No external credential or production side effect is implied by this record.
