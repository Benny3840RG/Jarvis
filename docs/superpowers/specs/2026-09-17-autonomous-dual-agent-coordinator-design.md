# Autonomous Dual-Agent Coordinator Design

## Goal

Remove routine owner dispatching from an approved autonomous development mission while preserving Benny's sole authority to merge, deploy, close, or abandon a mission.

## Existing controls retained

- `jarvis-queue-advance.yml` remains the sole serialized dispatcher and retains its global mission lock.
- `jarvis-autobuild.yml` remains the bounded Codex builder executor and accepts only a verified source SHA.
- `jarvis-pr-maintenance.yml` remains an independent, read-only, **advisory** review with exact PR/head/base/CI-fingerprint binding.
- Existing CI and CodeQL provenance checks, repair limits, branch/draft boundaries, and Development/Omega authority are not weakened.
- The coordinator has no merge, approval, ready-for-review, deployment, commission, issue-close, or protection-setting operation.

## Smallest coordinator

Add a pure `.github/automation/dual-agent-mission.mjs` module. It validates and renders a versioned GitHub issue-comment receipt that is informational only; workflow/run state remains the authority for dispatches and evidence. Before every transition or render, it rejects malformed persisted state: unsupported version or phase, invalid issue/base SHA/roles, an out-of-range repair count, or missing, malformed, or base-mismatched candidate identity in a candidate-bound phase. The receipt records one mission identity:

- claimed issue number and its trusted candidate PR number;
- verified base SHA, candidate head SHA, and CI fingerprint;
- fixed builder/reviewer pair selected from the persisted rotation;
- phase: `claimed`, `waiting-ci`, `reviewing`, `repair-required`, `awaiting-owner`, `blocked`, or `terminal`;
- original builder and repair count, so repairs cannot silently change ownership;
- the only allowed owner interrupts: merge, deployment, or an explicit blocked ambiguity/risk.

When a dedicated Claude write-capable executor is available, the selected builder alternates only from a persisted terminal mission carrying Benny's trusted merge, close, or abandonment evidence; the independent reviewer remains a separate read-only Codex maintenance invocation. Until then, an unavailable selected Claude builder is a transparent `blocked` state—not a fallback that pretends Claude work occurred. The existing Codex executor is selected where capability exists; independent Codex PR maintenance is a separate invocation and never its own candidate's builder.

## Flow

1. Queue admission confirms healthy `main`, no live lock/PR/worker, and an approved issue. It emits the claim receipt bound to the verified source SHA and selected roles before dispatching the existing builder.
2. Builder publication records the exact draft PR/head and moves the receipt to `waiting-ci`.
3. Existing maintenance waits for trusted exact-head CI and CodeQL, dispatches its independent advisory review using PR/head/base/fingerprint, and records `reviewing`.
4. A clean advisory review and unchanged evidence produce `awaiting-owner`; the only result is an owner-facing summary. It does not mark ready, approve, merge, or deploy.
5. Actionable findings route only to the original builder through the existing bounded repair path. A changed head or fingerprint on the same PR and same independently verified base invalidates the previous review and returns to `waiting-ci`; repair remains bound to the original builder and PR. A moved base is rejected and yields a blocked mission requiring an independently validated reset.
6. A receipt can reach `awaiting-owner` only when its exact candidate is accompanied by a clean advisory-review verdict and trusted-success CI evidence. Missing provenance, review context, moved base, unsupported builder capability, or exhausted budgets yields `blocked` with a precise owner action. Only trusted owner evidence of a merge, close, or abandonment produces `terminal` and makes rotation eligible for the next mission.

## Workflow integration

The initial safe increment is a tested controller module plus workflow-contract assertions and an owner-facing operations document. It consumes existing Actions evidence rather than adding mutable state, tokens, or privileges. Follow-up workflow hooks may only call it to render facts already verified by the existing queue/maintenance controllers.

## Tests

Unit tests prove role alternation only after terminal state; exact SHA and fingerprint validation; malformed persisted-state rejection; same-builder repair routing; stale-head/base invalidation; unavailable-builder blocking; and that no owner authority can be represented by a receipt. Duplicate/overlap refusal is deliberately enforced and tested at the queue boundary, which has the authoritative global lock, open-PR and active-worker state; the stateless receipt controller cannot safely arbitrate a second claim. Workflow contract tests ensure the advisory review model and no new merge/deploy permissions remain intact.
