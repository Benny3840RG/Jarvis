# CI health and workflow expectations

This document describes the expected state of each GitHub Actions workflow, what constitutes a healthy CI pipeline, and how to diagnose and recover from workflow failures.

## Workflows

| Workflow | File | Trigger | Purpose |
| --- | --- | --- | --- |
| TypeScript checks | `typescript.yml` | Push to `main`, PR to `main` (TypeScript, automation, or workflow paths) | Full verification gate: automation policy, type-check, lint, format, OpenAPI lint, tests with coverage |
| Python checks | `python-app.yml` | Push to `main`, PR to `main` (Python paths) | Lint and test the legacy Python prototype |
| Queue development commissioning | `queue-development-commissioning.yml` | Push to `main` when a request file changes | Queues and monitors one uniquely identified development commissioning request; duplicate request IDs are ignored and issue #54 records consumption |
| Development commissioning | `development-commissioning.yml` | Manual dispatch only (`workflow_dispatch`) | Authorised end-to-end commissioning: deps, checks, Convex sync, smoke test, HTTP start, Totality probe, backup verify |
| Jarvis autonomous build | `jarvis-autobuild.yml` | `automation-approved` issue label or manual issue retry | Bounded Codex implementation that opens a draft PR; never merges, commissions, or deploys |

## Expected baseline state

**`main` must always be green for `typecheck-lint-format-test` and `automation-policy`.**

The development commissioning workflow is intentionally manual-dispatch only and does not run on every push. Its last result is recorded in issue #54.

## Diagnosing failures

### TypeScript checks (`typecheck-lint-format-test`)

Run locally:

```bash
cd typescript
npm ci
npm run type-check
npm run lint
npm run format:check
npm run openapi:lint
npm run test:coverage
```

The full suite can also be run as:

```bash
npm run check
```

### Automation policy (`automation-policy`)

Run locally from the repository root:

```bash
node --test .github/automation/validate-autobuild.test.mjs
```

This check verifies issue eligibility, forbidden diff paths, secret redaction, immutable action pins, bounded Codex instructions, draft-only publication, cleanup, and CI integration. Treat a failure as a blocked automation-control change.

Common failure modes:

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `tsc` type error | Type mismatch or missing type update | Fix the TypeScript type error in the reported file |
| ESLint error | Lint rule violation | Run `npm run lint` locally and fix the reported line |
| Prettier format error | Code not formatted | Run `npm run format` to auto-fix, then commit |
| OpenAPI lint warning | OpenAPI contract has a warning or error | Run `npm run openapi:lint` and fix the reported issue |
| Test failure | Logic regression or a flaky test | Run `npm run test` locally and inspect the failure output |

### Python checks (`python-tests`)

Run locally:

```bash
python -m pip install -e .
python -m pip install pytest flake8
flake8 . --count --select=E9,F63,F7,F82 --show-source --statistics
pytest
```

### Development commissioning

Development commissioning failures are recorded in issue #54 with a redacted log excerpt.

If commissioning fails:

1. Check issue #54 for the failed-step name and redacted log.
2. Reproduce the failing step locally if possible (Convex sync, HTTP start, Totality probe, or backup verify).
3. Fix the root cause on `main` (or a PR targeting `main`).
4. Create a new `.github/commission-development` request containing the exact `COMMISSION DEV` first line and a fresh unique `request-id`; never reuse a consumed request ID. The queue workflow records the ID in issue #54 before dispatch.

## CI stability expectations

- **`main` must never have a failing `typecheck-lint-format-test` or `automation-policy` run.** If it does, treat it as a blocking defect.
- **Draft PRs are allowed to have failing CI** while work is in progress, but a PR must not be promoted from draft to ready-for-review while CI is red.
- **Preview workflows** (see `docs/operations/preview-features.md`) may have targeted failures during active development but must not introduce regressions in the stable test suite.

## Adding new required checks

When a new workflow is introduced that should block merges:

1. Ensure the workflow consistently passes on `main` before adding it as a required check.
2. Add it to the branch protection rules as described in `docs/operations/branch-protection.md`.
3. Update the table in this document.
