# Jarvis autonomous builds

Jarvis implements **one bounded GitHub issue at a time, end to end**. The system creates a draft pull request; it cannot mark the PR ready, merge, commission, or deploy.

`jarvis-autobuild.yml` no longer runs on the `automation-approved` label. It has a single trigger, `workflow_dispatch`, and one repository-global concurrency group, so only one autonomous-build worker can ever run. `jarvis-queue-advance.yml` is the sole coordinator: it verifies `main` is healthy, then dispatches the builder for the next eligible approved issue. A mission occupies the queue from dispatch until its pull request is merged or closed — not just while the coding worker runs (see [Queue advance](#queue-advance)).

## Smoke-test verification

Approved automation opens autonomous output as a draft pull request. Owner review and merge remain mandatory, and commissioning and deployment are never automatic.

## Preparing an eligible issue

The issue must be open and carry `automation-approved`. It must include testable acceptance criteria:

```markdown
## Acceptance criteria

- [ ] Observable result one
- [ ] Test or verification result two
```

Adding `automation-approved` no longer starts a build. It records the authority decision and adds the issue to the queue; the coordinator dispatches it when its turn comes. Applying the label is still an authority decision: review the complete issue first, including hidden HTML, links, attachments, and comments that could contain hostile instructions.

## Labels

| Label                    | Meaning                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `automation-approved`    | Owner or repository writer authorises one bounded attempt; the coordinator will dispatch it |
| `automation-in-progress` | The mission lock. Held from dispatch until the candidate pull request is merged or closed |
| `automation-blocked`     | The last attempt stopped and needs operator attention                                   |
| `automation-generated`   | Branch or draft PR was produced by the autonomous builder                               |

`automation-approved` is what the coordinator reads to pick the next mission, so review each issue completely before applying it.

## Parallel eligibility

Autonomous builds are serial: one mission occupies the pipeline from approval through merge, and the next is not dispatched until it completes. Work that genuinely must proceed in parallel uses normal reviewed pull requests, not the autonomous builder.

## Queue advance

`.github/workflows/jarvis-queue-advance.yml` is the single coordinator. It **only dispatches** `jarvis-autobuild.yml`; it never reviews, approves, marks ready, merges, commissions, or deploys, and never holds write access to repository contents. Its definition is always resolved from the base branch, so a merged pull request cannot change this logic. Selection logic lives in `.github/automation/select-next-mission.mjs` and is unit and behaviourally tested.

The operator's approval of an issue (`automation-approved`) is the authority record. The coordinator dispatches an already-approved issue as `github-actions[bot]`; that identity is **not** treated as approval. The builder re-checks the `automation-approved` label, `automation-blocked` state, acceptance criteria, the mission lock, existing candidate PRs, and any other active mission on every run, immediately before work, while holding the global concurrency lease. A human `workflow_dispatch` is additionally gated on writer permission.

### Revision health is verified twice, bound to one SHA

The rule set lives in `.github/automation/revision-health.mjs` and is applied by both the coordinator and the builder. A revision is healthy only when all of these are `success` from their trusted producer:

| Check | Trusted producer (workflow-run `path`) |
| --- | --- |
| `automation-policy`, `typecheck-lint-format-test`, `jarvis-console-01-build` | `.github/workflows/typescript.yml` |
| `Analyze (actions)`, `Analyze (python)`, `Analyze (ruby)`, `Analyze (javascript-typescript)` | `dynamic/github-code-scanning/codeql` |

There is no aggregate `CodeQL` check on `main` — only these individual per-language analyses. A missing, failed, cancelled, `neutral`, still-pending, or wrong-producer check blocks.

1. **Coordinator** `verify-main` runs on **every** dispatch path. It resolves the current `main` HEAD, verifies that revision, and passes the exact SHA to the builder as the `source_sha` input. Because the target is always `main` HEAD, a scheduled sweep cannot bypass an earlier failure: while a bad revision sits on `main`, nothing is dispatched.
2. **Builder** `Verify the dispatched source revision` re-does the check for `source_sha` before it checks anything out, confirms that SHA is `main` or an ancestor of it (`compareCommitsWithBasehead`), then checks out **that exact SHA** — not a moving `main`. A merge that lands between coordinator verification and builder checkout cannot slip unverified code into a mission. A manual `workflow_dispatch` that omits `source_sha` uses `main` HEAD and is verified the same way, so a manual build cannot skip the health gate.

`revision-health.mjs` is hashed into the builder's immutable control manifest alongside `validate-autobuild.mjs`.

### Triggers

| Trigger | Behaviour |
| --- | --- |
| `automation-approved` applied to an issue | Verify `main`, then dispatch the next eligible mission if none is active. |
| An `automation-generated` pull request is **merged** | Verify `main` (now the merge commit), release that mission's lock, then dispatch the next. |
| An `automation-generated` pull request is **closed unmerged** | Label its issue `automation-blocked` and comment. Do **not** advance. |
| `schedule` (every 6 hours) | Recovery sweep for missed events. |
| `workflow_dispatch` | Manual sweep. |

### One mission at a time

The coordinator dispatches nothing while a mission is occupied: any open issue carrying `automation-in-progress`, any open `automation/issue-*` pull request, or any queued/running builder run. It selects the lowest-numbered eligible issue, re-fetches it, and re-checks eligibility immediately before `createWorkflowDispatch`. The builder then re-checks again under the global lease. Multiple approvals, manual sweeps, and concurrent triggers therefore dispatch at most one worker; the rest keep their `automation-approved` label and are picked up one by one as each mission's PR merges.

If `main` moves between `verify-main` and dispatch, the coordinator defers to the next trigger rather than dispatch against an unverified revision.

### Stale-lock recovery

If a `pull_request:[closed]` event is missed, an issue can keep `automation-in-progress` with no live candidate behind it, which would stall the queue forever. On a **sweep only** (`schedule` / `workflow_dispatch`), the coordinator reconciles: for each held lock with **no** open candidate PR **and** no autonomous-build run active across the paginated history, it verifies that the newest bot-authored lock receipt identifies a completed builder run before releasing the lock, setting `automation-blocked`, and commenting. Missing, inaccessible or non-terminal owning-run evidence preserves the lock. A lock with an open candidate PR, or any lock while a builder run is active, is left untouched — genuinely live locks are never cleared. Merge and approval triggers do not reconcile; only sweeps do.

### Queue advance failures

- `verify-main` red or timed out: the queue **does not advance**. On a merge trigger it comments the failing checks on the merged pull request. Repair `main`; the next merge or scheduled sweep resumes the queue.
- A candidate pull request closed **unmerged**: its issue is set `automation-blocked`. Clear the label with a manual retry after fixing the blocker.
- A stale open automation pull request halts the queue by design. Merge or close it; the coordinator never force-clears a lock or closes a candidate.
- The coordinator never retries a blocked issue.

## Normal lifecycle

1. A repository writer reviews the issue and acceptance criteria and adds `automation-approved`.
2. The coordinator verifies the current `main` revision is healthy and, when no mission is occupied, dispatches the builder for this issue with that verified SHA as `source_sha`.
3. The builder re-checks eligibility under the global lease, applies `automation-in-progress`, re-verifies `source_sha` health and that it is on `main`, then checks that exact SHA out.
4. Codex edits the isolated checkout under the repository policy.
5. A trusted guard rejects forbidden or excessive changes.
6. The builder pushes an attempt-specific `automation/issue-<number>/run-<run-id>` branch and opens one draft PR labelled `automation-generated`.
7. A separate secret-free job waits on the exact candidate SHA for the PR-scoped `automation-policy`, TypeScript, Console, PR Evidence, and CodeQL checks. It does not check out or execute the candidate tree in the default-branch workflow. `GITHUB_TOKEN`-created draft PRs often leave those workflows waiting for approval; the verifier attempts to approve them so verification stays PR-scoped.
8. The builder publishes one namespaced `jarvis-autobuild/verify-candidate` status on the draft PR and blocks the issue if those required checks fail or time out.
9. Ordinary TypeScript, Console, PR Evidence, and CodeQL checks keep their own names and remain authoritative. The autonomous verifier never impersonates or satisfies them.
10. **The mission lock stays on the issue.** The queue does not advance while the draft PR is open.
11. The owner (or a `@Benny3840` CODEOWNERS review) reviews the diff, Copilot's independent review, the checks, and remaining risk. Copilot and the builder cannot approve or merge; `.github/CODEOWNERS` requires human review of `.github/**`.
12. The owner marks the PR ready and squash-merges it. Only the owner may change draft state or merge.
13. The merge closes the issue (`Closes #<n>`) and triggers the coordinator: it verifies the post-merge `main`, releases the lock, and dispatches the next mission.

### Handoff to review and merge

Every queue-generated candidate reaches a human the same way: a draft PR with `automation-generated`, `jarvis-autobuild/verify-candidate` plus the five required checks on the exact head, a Copilot review, and CODEOWNERS review on `.github/**`. Neither `jarvis-autobuild.yml` nor `jarvis-queue-advance.yml` has `pull-requests` permission beyond commenting, and neither calls any merge, approve, review, or ready-for-review API — enforced by `validateQueueAdvanceContract` and the builder contract tests. This handoff is generic; it is not tied to any single issue or PR.

Held PR workflow runs are returned by GitHub with `status: completed` and
`conclusion: action_required`. The verifier checks both fields before approving
the exact candidate's PR runs. A denied approval remains a failure; no stronger
token or bypass is substituted. The workflow does not use the administrator-only
Actions settings endpoint as an eligibility requirement.

## Manual retry

Use **Actions → Jarvis autonomous build → Run workflow**, enter the issue number, and leave `source_sha` blank (it defaults to `main` HEAD, which is verified before work) — only after correcting the recorded blocker. Remove a stale `automation-in-progress` label only after confirming no run is active, or let the next scheduled sweep reconcile it.

The workflow does not retry automatically. This prevents repeated API spend and repeated unsafe edits. Agent-reported checks are advisory; the dispatched revision's health and the PR-scoped CI on the exact candidate SHA are machine-enforced.

## Hard stops

The builder must stop for:

- production or Convex commissioning/deployment;
- secrets, tokens, permissions, workflows, or automation controls;
- dependency manifests or lockfiles;
- Convex schema or destructive data changes;
- authentication or security policy;
- billing or paid infrastructure;
- external actions with real-world effect;
- ambiguous requirements or broader scope.

Split such work into a reviewed design and owner-approved implementation instead of weakening the guard.

## Failure recovery

A failed run that never published a candidate removes `automation-in-progress`, applies `automation-blocked`, and comments with the run URL. A run that published a draft PR keeps `automation-in-progress` until the coordinator sees that PR merged or closed. Review the failed step and redacted logs.

- If no branch exists, correct the issue and retry manually; each attempt receives a unique branch.
- If a draft PR exists, inspect or close it before retrying. Open automation PRs prevent duplicate attempts.
- If a branch exists but PR creation failed, a manual retry can safely create a new attempt-specific branch; stale branch cleanup remains an operator decision.
- If any credential exposure is suspected, cancel the run, revoke the key, and investigate before retrying.

### Bounded worker and diagnostic receipt

Dependency installation has a five-minute step limit and the Codex worker has a
30-minute step limit inside the 45-minute build job. A worker timeout remains a
failure: it cannot publish a partial candidate, and normal cleanup still runs.
The independent finalizer retains a JSON receipt in its existing issue comment,
so stage evidence survives expiry of the detailed Actions logs.

The receipt includes the run ID and issue number, source SHA when available, build and
verification results, and dependency/worker/guard/publication outcomes. It contains
no prompts, model output, raw logs or credential values. Missing outcomes after
cancellation are recorded as `unavailable`, never inferred as success. A worker
`failure` alone does not distinguish a timeout from a provider or execution error.
Use the linked Actions step details when they are available.

The receipt is diagnostic only. Existing exact-candidate CI, independent review,
draft-only publication and owner merge controls still apply. It does not authorise
a retry. Check whether the original issue was already implemented before retrying;
for example, #435 was implemented by PRs #442/#443 after its builder attempts failed.

## API key and cost control

`OPENAI_API_KEY` must exist only as a GitHub Actions repository secret. Never place it in issue text, PR text, workflow input, artefacts, logs, or repository files.

Monitor OpenAI project usage and set an appropriate project budget. Rotate or revoke the key when access changes, suspicious usage appears, or the workflow is retired.

## Cancellation

Cancel the active Actions run, then confirm it has reached a terminal state. The cleanup step should release the issue lock. If cancellation prevents cleanup, remove `automation-in-progress` manually after confirming no runner remains active.

## Production boundary

Autonomous builds never commission or deploy. Jarvis development commissioning remains a separate guarded workflow, and production deployment always requires explicit owner approval.

## Repository setting

GitHub Actions must be allowed to create pull requests: **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. This permits draft PR creation and approval of the exact candidate's held CI workflow runs only; the workflow cannot approve a pull request or merge it.
