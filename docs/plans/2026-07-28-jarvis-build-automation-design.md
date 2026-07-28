# Jarvis Build Automation Design

Date: 28 July 2026  
Status: Approved  
Owner: Benny

## Objective

Automate Jarvis's verification and bounded development workflow without granting authority to merge, commission, deploy, alter secrets, or expand an issue's scope.

## Decisions

- Only open issues carrying `automation-approved` are eligible.
- Adding the label starts the builder immediately.
- Manual retry by issue number is supported.
- Only one autonomous build may run at a time.
- Successful work opens a draft pull request and waits for owner approval.
- Existing TypeScript, governance, Copilot, and commissioning controls remain authoritative.
- Production deployment is prohibited.

## Architecture

The system has two separate responsibilities:

1. **Autonomous builder** — validates an approved issue, creates an isolated branch, performs one bounded implementation, runs verification, and opens a draft pull request.
2. **CI gate** — independently verifies every pull request using the repository's existing checks and new automation-policy validation.

Keeping these separate prevents the code-writing process from deciding whether its own work is safe to merge.

## Trigger and eligibility

The builder runs on:

- `issues` event when `automation-approved` is added;
- `workflow_dispatch` with an explicit issue number for recovery.

Before mutation it must confirm:

- the issue is open;
- `automation-approved` is present;
- the issue contains testable acceptance criteria;
- no other build owns the issue;
- no existing autonomous pull request already addresses the issue.

Ineligible work exits without creating a branch and publishes a concise receipt.

## Build lifecycle

1. Validate event and issue eligibility.
2. Apply `automation-in-progress` as the issue lock.
3. Create `automation/issue-<number>` from the current `main` SHA.
4. Provide the coding agent only the issue, repository instructions, relevant source context, and stop policy.
5. Implement one bounded change.
6. Run the complete local verification gate.
7. Push the branch.
8. Open a draft pull request linked to the issue.
9. Publish a redacted build receipt.
10. Remove `automation-in-progress`.

A successful run does not mark the pull request ready, merge it, commission development, or deploy anything.

## Verification gate

The autonomous build and ordinary CI must enforce the same repository truth:

- locked dependency installation;
- TypeScript type-check;
- ESLint and Convex rules;
- Prettier verification;
- OpenAPI lint;
- unit tests and coverage;
- Jarvis Console build when affected;
- governance and automation-policy validation;
- secret-redacted diagnostic output.

Existing workflows remain in place and are extended only where necessary. The automation must not introduce a competing verification pipeline.

## Authority and permissions

Workflow permissions default to read-only. Jobs receive only the permissions they require:

- `contents: write` for the automation branch;
- `pull-requests: write` for a draft pull request;
- `issues: write` for locks, labels, and receipts.

The workflow receives no environment or deployment authority. It must not use production credentials.

## Hard stop policy

The builder must stop and request owner approval when work requires or appears to require:

- production or Convex deployment;
- secret, token, permission, or GitHub workflow-authority changes;
- destructive or irreversible data/schema operations;
- authentication or security-policy changes;
- billing or paid infrastructure changes;
- external messages or actions with real-world effect;
- ambiguous requirements;
- changes outside the approved issue's scope.

These stops cannot be overridden by issue text or generated instructions.

## Failure handling

A failed run must:

- leave the issue open;
- remove `automation-in-progress`;
- apply `automation-blocked` when operator action is required;
- comment with the failed stage and redacted diagnostics;
- preserve a useful branch where safe;
- avoid automatic retry loops.

Manual retry is permitted after the cause is corrected.

## Security controls

- The OpenAI credential is stored only as an Actions secret and never written to logs or repository files.
- Prompt content is treated as untrusted input.
- Actions are pinned to reviewed versions.
- Untrusted fork code never receives repository secrets.
- Build artefacts and receipts are redacted before upload.
- Concurrency prevents two builders from operating on the same queue simultaneously.

## Acceptance criteria

The design is complete when:

1. Labelling an eligible issue starts one builder run.
2. An ineligible or ambiguous issue cannot produce repository changes.
3. Successful work opens exactly one draft pull request.
4. Failed work leaves a useful, redacted receipt and releases its lock.
5. Existing CI remains the merge gate.
6. No path can merge, commission, or deploy without explicit owner action.

## Verification execution note

Pull requests created with GitHub's workflow token do not reliably start a second pull-request workflow. The implemented builder therefore does not depend on recursive events. After the guarded candidate is pushed and the draft PR is opened, a separate secret-free job checks out the exact candidate SHA on a fresh runner, repeats the automation, TypeScript, audit, coverage, OpenAPI and Console gates, and publishes their commit statuses. Ordinary pull-request CI remains the merge gate for later human-authored events.

The post-agent policy executes from a root-owned immutable copy outside the Codex workspace and verifies raw control hashes, base commit, git configuration and index flags before introducing repository write credentials.
