# Maintained Orchestration and Dependency Follow-up — 2026-08-08

## Verified changes

The following changes are now on main at 2e04d101e09e1f8d43208cc4fe9e7f4eee086ba1:

- PR #321 refreshed js-yaml, nanoid, and console dompurify to audited versions.
- The exact-head dependency repair checks passed npm audit for both TypeScript workspaces.
- PR #320 added deterministic weighted dependency ordering to the maintained orchestration graph.
- PR #320 added trigger envelope validation and an in-process trigger registry.
- PR #320 added maximum-step and maximum-duration budgets to the maintained runner.
- Budget exhaustion is recorded as execution_budget_exceeded before the next effect boundary, while completed-step evidence is retained.
- PR #325 verifies provider-neutral run/step state semantics: idempotent replay/conflict handling, legal completion closure, and indeterminate outcomes that cannot be blindly retried.
- PR #329 adds Convex-backed durable runs and steps, server-issued worker-bound leases, server-derived lifecycle clocks, operation-bound reconciliation records, and fail-closed recovery.
- The exact PR #329 head tested in workflow run #1413 (31256419743) passed typecheck, lint, formatting, OpenAPI validation, Node/Convex tests, console build, and automation policy; Copilot Review Check 31256419737 also passed.

## Review boundary

The merged slice is a maintained offline persistence foundation, not a production commissioning claim. The exact-head review identified blockers that must be closed before a runner is composed or activated:

- worker identity is still caller-supplied under the shared service-token boundary;
- local reconciliation outcomes are caller-attested and must be replaced or joined to provider-authenticated `externalReconciliations` evidence;
- retryability must not be selected by an untrusted failure-code claim;
- trigger persistence must use allowlisted metadata/digests rather than raw payloads;
- authority and policy fields need server-side validation, not only recorded claims;
- retrying one failed step must not strand other failed steps; and
- no deployed restart or provider-reconciliation drill has been completed.

## Scope boundary

Durable Convex run/step state and reconciliation records now exist, but the runner is not yet composed with them, and production trigger ingress, authorization policy binding, checkpoint/resume drills, compensation, or governed HTTP/MCP activation remain open. Existing live blockers remain:

- Outlook OAuth and quote delivery proof: issues #293, #294, and #297.
- PostHog ingestion proof: issue #302.
- OIDC and remote gateway commissioning: issue #306.
- Production hosting, backup/restore, rotation, restart, rollback, and deployment approval: issue #307.
- Full local whole-repository security scanning remains unavailable in the connector-only environment.

## Next gate

Issue #333 is the next P4 hardening slice. It must bind indeterminate recovery to the existing provider-authenticated reconciliation path, tighten payload and retry semantics, and add focused safety tests. Only after that evidence exists should the maintained runner be composed with the Convex adapter and real trigger ingress. Restart/recovery and provider-level evidence remain required before any CLI, scheduler, HTTP, or MCP activation. No external credential or production side effect is implied by this record.
