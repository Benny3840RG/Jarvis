# Maintained Orchestration and Dependency Follow-up — 2026-08-08

## Verified changes

The following changes are now on main at a08a064d876f7def00a5bb8b3ab76d66aaed4594:

- PR #321 refreshed js-yaml, nanoid, and console dompurify to audited versions.
- The exact-head dependency repair checks passed npm audit for both TypeScript workspaces.
- PR #320 added deterministic weighted dependency ordering to the maintained orchestration graph.
- PR #320 added trigger envelope validation and an in-process trigger registry.
- PR #320 added maximum-step and maximum-duration budgets to the maintained runner.
- Budget exhaustion is recorded as execution_budget_exceeded before the next effect boundary, while completed-step evidence is retained.
- PR #325 verifies provider-neutral run/step state semantics: idempotent replay/conflict handling, legal completion closure, and indeterminate outcomes that cannot be blindly retried.
- PR #329 adds Convex-backed durable runs and steps, server-issued worker-bound leases, server-derived lifecycle clocks, operation-bound reconciliation records, and fail-closed recovery.
- The exact PR #329 head tested in workflow run #1413 (31256419743) passed typecheck, lint, formatting, OpenAPI validation, Node/Convex tests, console build, and automation policy; Copilot Review Check 31256419737 also passed.
- PR #335 composes the maintained runner with the Convex boundary: begin-run replay/conflict is handled before execution, leases are acquired before the executor, and durable terminal writes follow the existing audit record. Exact-head workflow #1432 (31257664623) and Copilot Review Check 31257664737 passed.

## Review boundary

The merged slices are maintained offline foundations, not a production commissioning claim. Runner composition is now verified, but the exact-head review still identifies blockers before live ingress or external effects are activated:

- the shared service-token boundary still needs a commissioned remote worker-identity and OIDC/gateway binding;
- local reconciliation outcomes still need to be joined to provider-authenticated `externalReconciliations` evidence;
- trigger persistence and policy fields need authoritative server-side binding rather than caller claims;
- retry progression and multi-failure recovery still need deployed drills; and
- no deployed restart or provider-reconciliation drill has been completed.

## Scope boundary

Durable Convex run/step state and maintained-runner composition now exist, but production trigger ingress, authorization policy binding, checkpoint/resume drills, compensation, or governed HTTP/MCP activation remain open. Existing live blockers remain:

- Outlook OAuth and quote delivery proof: issues #293, #294, and #297.
- PostHog ingestion proof: issue #302.
- OIDC and remote gateway commissioning: issue #306.
- Production hosting, backup/restore, rotation, restart, rollback, and deployment approval: issue #307.
- Full local whole-repository security scanning remains unavailable in the connector-only environment.

## Next gate

Issue #333 is the next P4 hardening slice. It must bind indeterminate recovery to the existing provider-authenticated reconciliation path, tighten payload and retry semantics, and add focused safety tests. The maintained runner is now composed with the Convex adapter; only after that evidence exists should real trigger ingress be enabled. Restart/recovery and provider-level evidence remain required before any CLI, scheduler, HTTP, or MCP activation. No external credential or production side effect is implied by this record.
