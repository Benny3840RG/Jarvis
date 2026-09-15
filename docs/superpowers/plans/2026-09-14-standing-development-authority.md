# Standing Development Authority Implementation Plan

> **For agentic workers:** use the normal verified development workflow. This plan changes Jarvis's control plane, so the implementation itself must remain a normal reviewed PR rather than an unattended self-modification.

**Goal:** Make ordinary Jarvis Development work self-driving through build, bounded retry, repair, checks and independent review while keeping control-plane, merge and deployment authority owner-controlled.

**Spec:** `docs/superpowers/specs/2026-09-14-standing-development-authority-design.md`

## Global constraints

- Standing ordinary Development uncertainty budget: `0.05`.
- `JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_<issue>` remains an optional per-issue override.
- No autonomous merge authority.
- No autonomous production deployment or commissioning authority.
- `.github/workflows/`, `.github/actions/`, `.github/automation/`, dependency manifests, secret/env material, schema/config authority and deployment/governance controls remain forbidden to unattended workers.
- Sensitive application paths require changes to their own corresponding module tests; unrelated area tests, deletions and rename-only changes do not qualify. Keyword scanning is an additional filter, not proof of correct logic.
- Exact-head CI and independent Jarvis review remain required before owner merge.

## Task 1: Standing uncertainty budget

**Files**

- `.github/automation/development-workflow.test.mjs`
- `.github/automation/run-development-actions.mjs`
- operator documentation

- [x] Add a failing contract test proving the issue-specific selector is retained and admission falls back to `0.05`.
- [x] Verify the new contract fails before implementation.
- [x] Make durable admission use `env.JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET || "0.05"`.
- [x] Preserve numeric validation in the existing durable Development admission path.
- [x] Document the standing default and optional per-issue override.

## Task 2: Permit tested application repairs without unlocking the control plane

**Files**

- `.github/automation/development-workflow.test.mjs`
- `.github/automation/validate-autobuild.mjs`

- [x] Add failing coverage for reconciliation, persistence, integration and ordinary Convex implementation changes with matching tests.
- [x] Preserve hard denial for automation/workflow controls, dependency manifests, env/secrets, schema/config authority, deployment/commissioning and governance controls.
- [x] Split path policy into hard-forbidden controls and test-gated sensitive application paths.
- [x] Keep diff-size, binary, symlink, matching-test and semantic authority-content guards.
- [x] Exclude test evidence itself from sensitive source-path gating.

## Task 3: Finite automatic recovery instead of instant owner reruns

**Files**

- `.github/automation/autobuild-recovery.mjs`
- `.github/workflows/jarvis-autobuild-recovery.yml`
- `.github/automation/development-workflow.test.mjs`

- [x] Add a pure recovery classifier with a maximum of two automatic retries.
- [x] Bind recovery to completed `Jarvis autonomous build` workflow runs and the exact bot-authored diagnostic receipt for that run ID.
- [x] Retry only pre-publication dependency/worker failures.
- [x] Clear `automation-blocked` only for a classified retry and re-enter through `jarvis-queue-advance.yml` on `main`.
- [x] Keep policy-guard failures, stale mission locks, invalid evidence, non-retryable failures and exhausted retries blocked.
- [x] For a hard block, automatically request read-only `@claude` advice with the exact run/stage summary.
- [x] Grant the recovery workflow no content-write, PR-approval, merge or deployment authority.

## Task 4: Verification gate

Review repair sources: `.github/automation/autobuild-recovery.mjs`,
`.github/automation/autobuild-recovery.test.mjs`,
`.github/automation/validate-autobuild.mjs` and
`.github/automation/validate-autobuild.test.mjs` cover malformed recovery
evidence and per-module test matching. Both defects were reproduced with failing
regressions before repair. Fresh checks and independent review remain required.

- [ ] Required exact-head `automation-policy` passes.
- [ ] Required exact-head `typecheck-lint-format-test` passes.
- [ ] Required exact-head `jarvis-console-01-build` passes.
- [ ] Required exact-head `pr-evidence` and CodeQL checks pass.
- [ ] Independent `jarvis-pr-maintenance/review` passes on the exact current head.
- [ ] Final diff inspection confirms no autonomous merge/deployment path and no self-modification escape hatch.

The PR stays unmerged until every item in Task 4 is proven. Benny remains merge authority.
