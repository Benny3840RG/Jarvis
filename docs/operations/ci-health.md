# CI health and workflow expectations

This document describes the expected state of each GitHub Actions workflow, what constitutes a healthy CI pipeline, and how to diagnose and recover from workflow failures.

## Workflows

| Workflow | File | Trigger | Purpose |
| --- | --- | --- | --- |
| TypeScript checks | `typescript.yml` | Push to `main`, PR to `main` (TypeScript or workflow paths) | Full verification gate: type-check, lint, format, OpenAPI lint, tests with coverage |
| Python checks | `python-app.yml` | Push to `main`, PR to `main` (Python paths) | Lint and test the legacy Python prototype |
| Queue development commissioning | `queue-development-commissioning.yml` | Push to `main` when `.github/commission-development` changes | Queues and monitors the guarded development commissioning run; updates issue #54 |
| Development commissioning | `development-commissioning.yml` | Manual dispatch only (`workflow_dispatch`) | Authorised end-to-end commissioning: deps, checks, Convex sync, smoke test, HTTP start, Totality probe, backup verify |

## Expected baseline state

**`main` must always be green for `typecheck-lint-format-test`.**

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
4. Re-trigger commissioning by pushing a new `COMMISSION DEV` line to `.github/commission-development`.

## CI stability expectations

- **`main` must never have a failing `typecheck-lint-format-test` run.** If it does, treat it as a blocking defect.
- **Draft PRs are allowed to have failing CI** while work is in progress, but a PR must not be promoted from draft to ready-for-review while CI is red.
- **Preview workflows** (see `docs/operations/preview-features.md`) may have targeted failures during active development but must not introduce regressions in the stable test suite.

## Adding new required checks

When a new workflow is introduced that should block merges:

1. Ensure the workflow consistently passes on `main` before adding it as a required check.
2. Add it to the branch protection rules as described in `docs/operations/branch-protection.md`.
3. Update the table in this document.
