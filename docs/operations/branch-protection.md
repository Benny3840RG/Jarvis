# Branch protection for `main`

Committing this document does not configure protection. Apply the owner-approved configuration through GitHub repository settings or the authenticated rulesets API.

## Required settings

These are the existing intended controls, not evidence of live enforcement. The owner must review the final configuration and the unresolved review-policy choices below before activating protection for `refs/heads/main`:

| Setting | Value | Reason |
| --- | --- | --- |
| Require a pull request before merging | Enabled | Prevents direct pushes to main |
| Require status checks to pass before merging | Enabled | Enforces CI gate |
| Require branches to be up to date before merging | Enabled | Prevents stale-branch merges |
| Do not allow bypassing the above settings | Enabled | Prevents override by administrators |
| Allow force pushes | Disabled | Protects commit history |
| Allow deletions | Disabled | Protects the branch |

## Required status checks

The maintained controller requires the following eight contexts for a PR. Keep this
list aligned with `.github/automation/revision-health.mjs` and
`.github/automation/pr-maintenance.mjs`; bind each required context to GitHub Actions
App ID **15368**, the observed producer on current main and PR checks.

| Check name | Expected App ID | Workflow / trusted producer |
| --- | --- | --- |
| `automation-policy` | 15368 | `.github/workflows/typescript.yml` |
| `typecheck-lint-format-test` | 15368 | `.github/workflows/typescript.yml` |
| `jarvis-console-01-build` | 15368 | `.github/workflows/typescript.yml` |
| `pr-evidence` | 15368 | `.github/workflows/copilot-check.yml` (PR only) |
| `Analyze (actions)` | 15368 | `dynamic/github-code-scanning/` |
| `Analyze (python)` | 15368 | `dynamic/github-code-scanning/` |
| `Analyze (ruby)` | 15368 | `dynamic/github-code-scanning/` |
| `Analyze (javascript-typescript)` | 15368 | `dynamic/github-code-scanning/` |

`pr-evidence` is not expected on a main push. Do not universally require the
path-filtered `python-tests` or governance-validation job: unrelated PRs may never
emit them. Conditional advisory-review jobs (`prepare`, `review`, `publish`) are
also not substitutes for these contexts or the owner's approval.

An App ID authenticates the publisher, not the workflow path or reviewed source.
The existing controller's exact-head/base, producer-path and evidence checks remain
necessary; native required-status semantics do not reproduce its stricter rejection
of skipped or neutral results. Managed CodeQL can publish duplicate language names
across runs, so verify the effective check selection during the ordinary-PR drill.
Branch rules do not grant ToolAction approval, ΩΣ completion or deployment authority.

## Current enforcement and owner decisions

Read-only GitHub verification on 2026-09-11 at main
`6d478809715b7d7e09885d9b71f6252ec86a3761` found protection **unenforced**:
`protected: false`, no effective branch rules, and disabled rulesets `18831602`
(`JaRvIs7`) and `19147000` (`main`). Both have empty branch selectors and bypass
lists. The stale main ruleset also has zero required approvals, code-owner review
disabled and the conditional `python-tests` check. Simply enabling it is insufficient.
[Issue #398](https://github.com/Benny3840RG/Jarvis/issues/398) is **open**, reopened
for the outstanding owner-controlled configuration and readback proof.

CODEOWNERS currently designates only `@Benny3840` on covered paths. GitHub confirmed
that account has admin access and the CODEOWNERS file has no reported errors.
However, PR authors cannot approve their own PRs. Requiring that sole code owner's
approval would block covered PRs authored by `Benny3840`, including the current
owner-authored workflow changes, unless another eligible code owner is nominated.

The owner must explicitly choose the approving-review count, code-owner review
policy and reviewer availability, along with stale-review/last-push and conversation
resolution requirements. This document does not select those values. Keeping formal
GitHub approvals optional would leave human review enforced only by the existing
owner approval process, not by GitHub; that limitation requires an explicit decision.
Preserve the intended no-bypass rule. Any exception needs a separate scoped owner
decision; a PR-only bypass can still bypass checks in its ruleset and is not an
approval-only exemption. Model/advisory reviews cannot supply human authority.

Before activation, re-read the current rulesets, branch, CODEOWNERS and check
producers; review the exact resulting configuration rather than reusing stale
settings. After an authorized update, inspect effective main rules and prove an
ordinary reviewed PR can land without bypass while failed or missing checks block
it. Confirm owner-authored changes have a satisfiable review path. Record actual
readback evidence in #398; no destructive force-push/deletion trial is required.

## Rationale

The audit identified that `main` has no branch protection rules. Without them:

- code that fails the TypeScript check can land directly on `main`,
- force-pushes can silently overwrite commit history,
- and there is no merge gate to enforce the commissioning workflow.

Enabling protection ensures that only code that passes the full verification gate (`npm run check`) can reach `main`, and that the commissioning workflow remains the correct path for deploying to the development stack.

## What this PR cannot do

GitHub branch protection rules are not stored in repository files. They are a GitHub-level repository setting. This document serves as the authoritative record of the intended protection configuration until the repository owner applies it through the GitHub UI.

See also: [GitHub documentation on branch protection rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule).
