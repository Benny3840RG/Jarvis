# Maintained Orchestration and Dependency Follow-up — 2026-08-08

## Verified changes

The following changes are now on main at 924bda923f540ede6b9a80eaf70ab115cff03969:

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
- PR #336 hardens that boundary by requiring provider/effect binding to the existing external reconciliation record, removing caller-attested terminal resolution, allowlisting trigger metadata, and narrowing retryability. Exact-head workflow #1440 (31257990451) and Copilot Review Check 31257990434 passed.
- PR #344 repairs the composed runner's durable failure boundary: pre-lease failures cannot create a lease from `stop()`, and leased preflight/executor failures preserve audit-before-fail ordering. Exact-head workflow #1446 (31258557727) and Copilot Review Check #725 (31258557732) passed.
- PR #350 binds composition-owned policy identity and derives canonical graph plan fingerprints before durable `beginRun`. Exact-head workflow #1470 (31260194108) and Copilot Review Check #749 (31260194109) passed.
- PR #352 hardens the autobuild control-plane validator and scopes concurrency regression assertions to the workflow group line. Exact-head workflow #1477 (31260896290) and Copilot Review Check #755 (31260896356) passed.

## Review boundary

The merged slices are maintained offline foundations, not a production commissioning claim. Runner composition and composition-owned plan/policy binding are now verified offline, but the exact-head review still identifies blockers before live ingress or external effects are activated:

- the shared service-token boundary still needs a commissioned remote worker-identity and OIDC/gateway binding;
- trigger ingress still needs authoritative server-side binding of request identity, trigger metadata, and live policy context; PR #350 binds composition policy identity offline but does not activate ingress;
- retry progression and multi-failure recovery still need deployed drills; and
- no deployed restart or provider-reconciliation drill has been completed.

## Scope boundary

Durable Convex run/step state, maintained-runner composition, offline composition-owned policy binding, and offline authenticated worker composition evidence now exist, but production trigger ingress, checkpoint/resume drills, compensation, or governed HTTP/MCP activation remain open. Existing live blockers remain:

- Outlook OAuth and quote delivery proof: issues #293, #294, and #297.
- PostHog ingestion proof: issue #302.
- OIDC and remote gateway commissioning: issue #306.
- Production hosting, backup/restore, rotation, restart, rollback, and deployment approval: issue #307.
- Full local whole-repository security scanning remains unavailable in the connector-only environment.

## Next gate

Issue #333 is complete as a pre-composition hardening slice. The next P4 gates under #324 are real trigger ingress, followed by deployed restart/restore and provider-level reconciliation before any CLI, scheduler, HTTP, or MCP activation. Composition-owned policy binding is now present offline; no external credential or production side effect is implied by this record.

## Historical addendum — authenticated worker composition evidence (2026-08-09)

- PR #354 records a verified OIDC principal on authenticated HTTP requests and freezes it as immutable request context.
- PR #356 composes the offline Convex durable orchestration boundary with that verified principal by deriving a bounded `oidc:<sha256>` worker fingerprint and rejecting composition when no verified principal exists.
- PR #356 exact head `7ad3cbd0e41dd753a903cdc79310d62a6ffa4332` passed [TypeScript workflow #1497](https://github.com/Benny3840RG/Jarvis/actions/runs/31318790900) and [Copilot Review Check #774](https://github.com/Benny3840RG/Jarvis/actions/runs/31318790894); its merge revision is `1e6e96171c01858bdc7fb19e5c415492624ceab0`.
- Scope remains offline-only: no CLI/scheduler/HTTP/MCP trigger activation, no production ingress, and no live provider/deployment effects were commissioned by this slice.
