# Jarvis parallel delivery operating model

## Purpose

Reduce delivery wall-clock time without weakening safety, verification, traceability, or production approval boundaries.

## Non-negotiable rule

Parallelism is allowed only when workstreams are independent. Shared-state, shared-file, security-boundary, schema, deployment, commissioning, or sequential dependency work remains ordered.

## Delivery lanes

Jarvis work is organised into four lanes:

1. **Code and safety** — bounded implementation and repair slices.
2. **GitHub and operations** — PR hygiene, workflow governance, repository controls, documentation and backlog truth.
3. **Integration commissioning** — Convex, Outlook, Sentry, PostHog and other external adapters, with real credentials and side effects kept behind explicit approval boundaries.
4. **Verification** — independent review, exact-head CI evidence, security checks, smoke tests and failure drills.

The lead integrates lane outputs and remains responsible for repository truth, conflicts, sequencing and acceptance.

## Parallelism gate

Before starting a slice in parallel, record:

- files and subsystems expected to change;
- upstream dependencies;
- whether the slice changes a shared contract;
- required verification;
- whether credentials, deployment, commissioning or external side effects are involved.

A slice may run concurrently only when there is no unresolved dependency and no expected overlapping write surface with another active slice.

## Hard sequential boundaries

Keep work sequential when any of the following applies:

- one slice consumes the output or contract of another;
- both slices modify the same source or control-plane files;
- authentication, authorisation, security policy or approval semantics are changing;
- Convex schema or migration order matters;
- production deployment or live commissioning is involved;
- failure handling depends on the exact result of an earlier slice.

## PR discipline

- Prefer small, reviewable PRs with one acceptance boundary.
- Do not reduce verification to increase throughput.
- Exact-head CI evidence is required before merge readiness is claimed.
- A PR that has drifted materially behind `main` must be refreshed or superseded before further review work.
- Do not spend repeated review cycles on a non-mergeable stale branch when the same outcome can be reproduced cleanly from current `main`.
- Independent PRs may be reviewed and verified concurrently.
- Dependent PRs must declare their order explicitly.

## Verification lane

Verification should overlap implementation where safe. For completed candidate heads, the verification lane checks:

- type-check and static analysis;
- relevant unit and integration tests;
- dependency and security checks;
- workflow and policy validation;
- targeted smoke tests;
- failure/recovery behaviour where the slice affects reliability or external effects.

The verifier does not merge, waive failures, or reinterpret missing evidence as success.

## Backlog freeze for Priority 1-4 completion

New ideas are recorded, not discarded, but do not interrupt the active Priority 1-4 critical path unless they fix a safety defect, correctness defect, production blocker or invalidate a current architectural assumption.

Later ideas remain queued until the agreed Priority 1-4 baseline is complete.

## Autonomous-build concurrency

The autonomous builder uses an issue-scoped concurrency key. Different approved issue numbers may execute concurrently; duplicate attempts for one issue resolve to the same key and remain serialised. The existing issue lock, attempt-specific branches, forbidden-path controls, immutable control verification, clean-runner verification, draft-PR boundary, owner-controlled merge, and commissioning/deployment hard stops remain unchanged.

Concurrency does not override the parallelism gate: unresolved dependencies or overlapping write surfaces require sequential reviewed delivery.

## Throughput metric

Optimise for completed, verified slices per unit time — not PR count, agent count, or lines changed.

A faster system that produces rework, stale branches or unverifiable merges is slower in practice.
