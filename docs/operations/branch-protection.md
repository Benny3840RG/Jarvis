# Branch protection for `main`

Committing this document does not configure protection. Apply the owner-approved configuration through GitHub repository settings or the authenticated rulesets API.

## Current decided state (2026-09-17, issue #563)

This section is the current source of truth. Everything below it up to
"Rationale" is the historical record of how the policy was investigated and
debated — kept for context, but superseded where it conflicts with this
section.

`main` is protected by **two independent, additive mechanisms**. Both apply
simultaneously; GitHub enforces the union of whatever each requires.

1. **Classic branch protection** (`GET /repos/.../branches/main/protection`),
   applied and closed out under issue #398 on 2026-09-14, unchanged since:
   required checks `pr-evidence`, `automation-policy`,
   `typecheck-lint-format-test`, `jarvis-console-01-build`, `CodeQL`; strict
   (branch must be up to date); force pushes and branch deletion blocked.
   `required_approving_review_count: 0` and code-owner review are **currently
   disabled, as a deliberate temporary policy, not drift**: CODEOWNERS
   currently names only `@Benny3840`, and a PR author cannot approve their
   own PR, so requiring review would block owner-authored PRs entirely.
   Revisit only alongside nominating a second eligible code owner or an
   explicit different review policy.
2. **A narrow repository ruleset**, `main required code scanning`, created by
   `.github/automation/configure-main-ruleset.mjs`: targets
   `refs/heads/main`, enforcement `active`, `bypass_actors: []`, and exactly
   one rule — `code_scanning`, tool `CodeQL`,
   `security_alerts_threshold: high_or_higher`, `alerts_threshold: errors`.
   This is the #563 fix: GitHub's CodeQL Default Setup can post a
   "configurations not found" result instead of running its per-language
   jobs when `main`'s own baseline scan is stale, which let PR #558 merge
   with no CodeQL evidence at all. The `code_scanning` rule blocks merge on a
   missing or in-progress result by design — that's the mechanism, not an
   extra setting. The severity thresholds are GitHub's current UI defaults,
   recorded as the baseline in effect, not a deliberate severity decision.

**`jarvis-pr-maintenance/review` is intentionally not a required check
anywhere.** It was explicitly excluded under #398 because it fails closed on
ambiguous/incomplete review context and can block a clean PR for reasons
unrelated to any real defect — observed on PR #502 (2026-09-14) and again on
PR #564 (2026-09-16, one review segment lacked the file under test in its own
context slice). Making it a hard, no-bypass gate before that failure mode is
fixed would risk deadlocking legitimate merges; this was reconfirmed, not
newly decided, during the #563 investigation. Revisit only after that
segmentation behavior is fixed and separately proven not to do this.

**`python-tests` stays path-filtered and is not a required check.** It only
runs on `src/**`/`tests/**`/`pyproject.toml`/`requirements.txt` changes. A
docs-only or TypeScript-only PR correctly never triggers it and is not
blocked waiting for it.

**Dependabot limitation — read this before assuming the `code_scanning` rule
protects Dependabot PRs.** GitHub documents that ruleset code-scanning merge
protection does not apply to Dependabot pull requests analysed under CodeQL
Default Setup. The rule above protects ordinary human/agent-authored PRs; a
Dependabot PR can still become mergeable without a completed CodeQL result,
by design on GitHub's side. The controls that do still apply to Dependabot
PRs: the five classic-protection checks, the up-to-date requirement, and the
fact that `allow_auto_merge` is `false` repo-wide (a human always has to
click merge). Closing the Dependabot-specific gap, if wanted, is a separate,
not-yet-implemented follow-up — track it on its own rather than assuming
this repair covers it.

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

## Required status checks (historical: nine-context proposal, not adopted)

An earlier draft of this document proposed requiring nine contexts in one
ruleset, including all four individual `Analyze (X)` CodeQL jobs and
`jarvis-pr-maintenance/review`. **That proposal was not adopted** — see
"Current decided state" above. It's kept here because it's what
`.github/automation/configure-main-ruleset.mjs` implemented before the #563
reconciliation, and because the reasoning below (App ID binding, why
`pr-evidence` doesn't appear on a main push, why `python-tests` can't be
universal) is still accurate background for anyone extending the current
narrow `code_scanning` ruleset.

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
| `jarvis-pr-maintenance/review` | 15368 | `.github/workflows/jarvis-pr-maintenance.yml` |

`pr-evidence` is not expected on a main push. Do not universally require the
path-filtered `python-tests` or governance-validation job: unrelated PRs may never
emit them. The maintenance workflow's internal `prepare`, `review` and `publish`
jobs are not separate required contexts; its exact-head status above is the Jarvis
gate. That status is not the owner's approval.

An App ID authenticates the publisher, not the workflow path or reviewed source.
The existing controller's exact-head/base, producer-path and evidence checks remain
necessary; native required-status semantics do not reproduce its stricter rejection
of skipped or neutral results. Managed CodeQL can publish duplicate language names
across runs, so verify the effective check selection during the ordinary-PR drill.
Branch rules do not grant ToolAction approval, ΩΣ completion or deployment authority.

## Current enforcement and owner decisions (historical: pre-#398-closure)

This section predates #398's closure on 2026-09-14 and is kept as the audit
trail of how classic protection was actually decided and applied. See
"Current decided state" above for what's live today. [Issue
#398](https://github.com/Benny3840RG/Jarvis/issues/398) is **closed**, with
live-merge proof (PR #502) recorded in its final comments.

Read-only GitHub verification on 2026-09-14 at main
`40393d04a31db81b2802199e3f234e99b4085464` found protection **unenforced**:
`protected: false`, no effective branch rules, and disabled rulesets `18831602`
(`JaRvIs7`) and `19147000` (`main`). Both have empty branch selectors and bypass
lists. The stale main ruleset also has zero required approvals, code-owner review
disabled and the conditional `python-tests` check. Simply enabling it is insufficient.

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
approval-only exemption. Model review cannot supply human authority. Its bounded
PASS is required candidate evidence; Benny's merge decision remains distinct.

PR #526 provides live producer proof for the new status name: exact head
`5207ba024b77b8f15a98698c5c4747ea24485757` received
`jarvis-pr-maintenance/review = success` from GitHub Actions App ID 15368 after
trusted CI and bounded review. This proves status publication, not branch
enforcement. GitHub still reported `main` unprotected after that PASS.

Before activation, re-read the current rulesets, branch, CODEOWNERS and check
producers; review the exact resulting configuration rather than reusing stale
settings. After an authorized update, inspect effective main rules and prove an
ordinary reviewed PR can land without bypass while failed or missing checks block
it. Confirm owner-authored changes have a satisfiable review path. Record actual
readback evidence in #398; no destructive force-push/deletion trial is required.

## One-shot owner application

`.github/automation/configure-main-ruleset.mjs` is the maintained one-shot
configuration and readback tool for the ruleset half of "Current decided
state" above — the narrow `main required code scanning` ruleset (`CodeQL`
`code_scanning` rule only, no bypass actors). It does not touch classic
branch protection (applied separately under #398) and does not include
`jarvis-pr-maintenance/review`, `python-tests`, or the individual
`Analyze (X)` checks — see "Current decided state" for why. It does not
restrict the merge button to a GitHub identity; the separate operating rule
remains that only Benny executes a merge.

Run its no-network dry run first from the repository root:

```bash
node .github/automation/configure-main-ruleset.mjs
```

Applying requires a fine-grained token scoped only to `Benny3840RG/Jarvis` with
repository **Administration: write** and **Metadata: read**. Enter it without
placing it in shell history:

```bash
read -rsp "GitHub token: " GITHUB_TOKEN
export GITHUB_TOKEN
node .github/automation/configure-main-ruleset.mjs \
  --apply \
  --repository Benny3840RG/Jarvis \
  --confirm-repository Benny3840RG/Jarvis
unset GITHUB_TOKEN
```

The tool refuses a repository identity/default-branch mismatch or another active
repository branch ruleset. It creates its named ruleset disabled, verifies the
exact preflight policy, activates it, then re-reads both the ruleset and effective
`main` rules. The readback rejects any additional effective rule, including one
inherited from another ruleset. It prefers GitHub's documented numeric
`ruleset_id`, accepts a nested source ID for response compatibility, and rejects
missing or conflicting source identities. If active readback fails, it disables
the new ruleset again. An uncertain activation response also triggers that
rollback, so an accepted request cannot silently leave unverified protection
active. It never
deletes or silently edits the two stale disabled rulesets. A second successful
run is read-only and reports the existing verified ruleset.

## Rationale

The audit identified that `main` has no branch protection rules. Without them:

- code that fails the TypeScript check can land directly on `main`,
- force-pushes can silently overwrite commit history,
- and there is no merge gate to enforce the commissioning workflow.

Enabling protection ensures that only code that passes the full verification gate (`npm run check`) can reach `main`, and that the commissioning workflow remains the correct path for deploying to the development stack.

## What this PR cannot do

GitHub branch protection rules are not stored in repository files. They are a GitHub-level repository setting. This document serves as the authoritative record of the intended protection configuration until the repository owner applies it through the GitHub UI.

See also: [GitHub documentation on branch protection rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule).
