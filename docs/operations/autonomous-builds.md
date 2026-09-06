# Jarvis autonomous builds

Jarvis can implement one bounded GitHub issue at a time. The system creates a draft pull request; it cannot mark the PR ready, merge, commission, or deploy.

## Smoke-test verification

Approved automation opens autonomous output as a draft pull request. Owner review and merge remain mandatory, and commissioning and deployment are never automatic.

## Preparing an eligible issue

The issue must be open and carry `automation-approved`. It must include testable acceptance criteria:

```markdown
## Acceptance criteria

- [ ] Observable result one
- [ ] Test or verification result two
```

Adding `automation-approved` starts the builder immediately. Applying the label is an authority decision: review the complete issue first, including hidden HTML, links, attachments, and comments that could contain hostile instructions.

## Labels

| Label                    | Meaning                                                   |
| ------------------------ | --------------------------------------------------------- |
| `automation-approved`    | Owner or repository writer authorises one bounded attempt |
| `automation-in-progress` | A build currently owns the issue                          |
| `automation-blocked`     | The last attempt stopped and needs operator attention     |
| `automation-generated`   | Branch or draft PR was produced by the autonomous builder |

Different approved issues may run concurrently. Attempts for the same issue remain serialised by the issue-scoped workflow concurrency group, the `automation-in-progress` lock, and existing automation-PR detection.

## Parallel eligibility

Concurrent execution is permitted only when approved issues have no unresolved dependency on one another and no expected overlapping write surface. Shared control-plane files, security boundaries, schemas, deployments, commissioning, and other sequential contracts remain ordered and must use normal reviewed work.

## Normal lifecycle

1. A repository writer reviews the issue and acceptance criteria.
2. They add `automation-approved`.
3. The workflow validates eligibility and applies `automation-in-progress`.
4. Codex edits the isolated checkout under the repository policy.
5. A trusted guard rejects forbidden or excessive changes.
6. The workflow pushes an attempt-specific `automation/issue-<number>/run-<run-id>` branch and opens one draft PR.
7. A separate secret-free job waits on the exact candidate SHA for the PR-scoped `automation-policy`, TypeScript, Console, PR Evidence, and CodeQL checks. It does not check out or execute the candidate tree in the default-branch workflow. `GITHUB_TOKEN`-created draft PRs often leave those workflows waiting for approval; the verifier attempts to approve them so verification stays PR-scoped.
8. The workflow publishes one namespaced `jarvis-autobuild/verify-candidate` status on the draft PR and blocks the issue if those required checks fail or time out.
9. Ordinary TypeScript, Console, PR Evidence, and CodeQL checks keep their own names and remain authoritative. The autonomous verifier never impersonates or satisfies them.
10. The owner reviews the diff, independent findings, checks, and remaining risk.
11. Only the owner may change draft state or merge.

## Manual retry

Use **Actions → Jarvis autonomous build → Run workflow** and enter the issue number only after correcting the recorded blocker. Remove a stale `automation-in-progress` label only after confirming no run is active.

The workflow does not retry automatically. This prevents repeated API spend and repeated unsafe edits. Agent-reported checks are advisory; PR-scoped CI on the exact candidate SHA is machine-enforced before the build is reported successful.

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

A failed run removes `automation-in-progress`, applies `automation-blocked`, and comments with the run URL. Review the failed step and redacted logs.

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

The receipt includes the run and issue IDs, source SHA when available, build and
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
