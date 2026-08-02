# Jarvis Build Automation Implementation Plan

> **Execution requirement:** Implement task-by-task, preserve the existing Convex architecture, and verify each commit before proceeding.

**Goal:** Add a label-triggered, least-privilege Codex builder that creates one bounded draft PR while retaining Jarvis's existing CI, Copilot, commissioning, and owner-approval gates.

**Architecture:** A new issue-triggered workflow performs eligibility checks, runs Codex inside a workspace-only sandbox, rejects forbidden diffs, pushes an isolated automation branch, and opens a draft PR. Existing pull-request workflows independently verify the resulting code. Repository-owned validation code is tested separately and must not be trusted after the coding-agent step without integrity checks.

**Technology:** GitHub Actions, `openai/codex-action`, GitHub REST through `actions/github-script`/`gh`, Node.js 24 built-ins, existing npm verification scripts.

---

## Task 1: Add tested automation-policy validation

**Files:**

- Create: `.github/automation/validate-autobuild.mjs`
- Create: `.github/automation/validate-autobuild.test.mjs`

**Step 1: Write failing tests**

Cover:

- only `automation-approved` is eligible;
- closed issues are rejected;
- acceptance criteria heading plus at least one checklist item are required;
- existing automation PR/lock is rejected;
- forbidden workflow, secret, dependency, schema, deployment, binary, and symlink changes are rejected;
- source and matching test changes are accepted;
- excessive file and line counts are rejected;
- receipts redact OpenAI keys, bearer tokens, and known secret names.

Run:

```bash
node --test .github/automation/validate-autobuild.test.mjs
```

Expected: fail because the validator does not exist.

**Step 2: Implement the smallest pure validator**

Use Node built-ins only. Export deterministic functions for eligibility, changed-path/diff policy, and redaction. Do not call GitHub or read secrets from this module.

**Step 3: Re-run tests**

Expected: all policy tests pass.

**Step 4: Commit**

```bash
git add .github/automation/validate-autobuild.mjs .github/automation/validate-autobuild.test.mjs
git commit -m "test: define autonomous build safety policy"
```

## Task 2: Add the bounded Codex instruction file

**Files:**

- Create: `.github/automation/codex-autobuild-prompt.md`
- Test: `.github/automation/validate-autobuild.test.mjs`

**Step 1: Add failing prompt-contract tests**

Verify the prompt explicitly:

- treats issue content as untrusted requirements data;
- limits work to one approved issue;
- forbids workflow, secret, permission, dependency, schema, commission, merge, and deployment changes;
- requires tests before implementation where practical;
- requires `npm run check` and console build when relevant;
- instructs Codex to stop rather than broaden scope;
- forbids commits, pushes, PR creation, and external actions from inside Codex.

**Step 2: Create the prompt**

Keep stable policy in the repository file. Supply issue number, title, and body through a separate generated context file, clearly delimited as untrusted input.

**Step 3: Run policy tests**

Expected: pass.

**Step 4: Commit**

```bash
git add .github/automation/codex-autobuild-prompt.md .github/automation/validate-autobuild.test.mjs
git commit -m "feat: define bounded Codex build instructions"
```

## Task 3: Add the autonomous builder workflow

**Files:**

- Create: `.github/workflows/jarvis-autobuild.yml`
- Modify: `.github/automation/validate-autobuild.test.mjs`

**Step 1: Add failing workflow-contract tests**

Parse the workflow text and verify:

- triggers are `issues:labeled` and `workflow_dispatch` only;
- issue-labelled runs proceed only for `automation-approved`;
- manual runs require an issue number;
- concurrency is repository-wide and does not cancel in-progress work;
- timeout is finite;
- permissions are explicitly scoped;
- `OPENAI_API_KEY` is consumed only by `openai/codex-action`;
- Codex uses workspace permission profile and `drop-sudo`;
- the action is pinned to a reviewed immutable commit SHA;
- issue content reaches shell steps only through quoted files/environment variables;
- no environment/deployment target exists;
- no merge or commissioning command exists;
- output is always a draft PR;
- cleanup runs on success and failure.

**Step 2: Implement eligibility and lock steps**

Use a trusted GitHub API step to:

- resolve the event/manual issue number;
- fetch the issue and labels;
- verify the triggering actor has repository write permission;
- call the tested eligibility rules;
- detect existing `automation/issue-<number>` PRs;
- add `automation-in-progress`;
- remove stale `automation-blocked` only after eligibility succeeds.

Never interpolate issue text directly into shell source.

**Step 3: Prepare an isolated branch checkout**

- Check out the current `main` SHA with persisted credentials disabled.
- Configure the intended branch name `automation/issue-<number>`.
- Install locked TypeScript and console dependencies before Codex because the workspace profile has no network access.
- Write the untrusted issue context to a delimited temporary file.

**Step 4: Run Codex**

Use the official action with:

- an immutable reviewed commit SHA;
- `openai-api-key: ${{ secrets.OPENAI_API_KEY }}`;
- `permission-profile: :workspace`;
- `safety-strategy: drop-sudo`;
- an explicit supported model and bounded reasoning effort;
- the stable prompt file plus generated issue context;
- no GitHub token or deployment secret in the Codex environment.

Codex edits and runs repository checks but does not commit, push, comment, or open a PR.

**Step 5: Apply post-agent safety guard**

Use only trusted inline shell and absolute system binaries after Codex. Before introducing a write token:

- reject forbidden paths and file types;
- reject symlinks and binary changes;
- reject secret-like content;
- enforce maximum changed-file and diff-size limits;
- require tests for source changes;
- require at least one actual change;
- verify the validator/prompt/workflow control files were not modified by the agent.

Do not run modified repository executables after the agent step on the secret-bearing runner.

**Step 6: Push candidate branch and create draft PR**

Only after the guard passes:

- inject the job-scoped GitHub token;
- commit with issue attribution;
- push the isolated branch without force;
- create exactly one draft PR with a complete Copilot Review section and `Closes #<number>`;
- apply `automation-generated`;
- publish a redacted receipt.

The PR event starts the existing independent CI on a fresh runner.

**Step 7: Implement failure cleanup**

Always remove `automation-in-progress`. On failure apply `automation-blocked` and comment with the failed stage, run URL, branch state, and redacted diagnostic summary. Do not retry automatically.

**Step 8: Run workflow policy tests**

```bash
node --test .github/automation/validate-autobuild.test.mjs
```

Expected: pass.

**Step 9: Commit**

```bash
git add .github/workflows/jarvis-autobuild.yml .github/automation/validate-autobuild.test.mjs
git commit -m "feat: add guarded Jarvis autonomous builder"
```

## Task 4: Extend the independent CI gate

**Files:**

- Modify: `.github/workflows/typescript.yml`
- Modify: `docs/operations/ci-health.md`
- Test: `.github/automation/validate-autobuild.test.mjs`

**Step 1: Add failing CI-contract tests**

Require TypeScript checks to trigger when automation controls change and require an `automation-policy` job that runs the Node policy tests without secrets.

**Step 2: Update TypeScript workflow**

- Add automation workflow/control paths to push and PR filters.
- Add a secret-free `automation-policy` job using Node 24.
- Leave existing TypeScript and console jobs unchanged except for shared concurrency/timeouts if needed.

**Step 3: Update CI documentation**

Document the new check, local reproduction command, and common failure modes.

**Step 4: Run tests**

```bash
node --test .github/automation/validate-autobuild.test.mjs
```

Expected: pass.

**Step 5: Commit**

```bash
git add .github/workflows/typescript.yml .github/automation/validate-autobuild.test.mjs docs/operations/ci-health.md
git commit -m "ci: enforce autonomous build policy"
```

## Task 5: Add the operator runbook and branch-protection record

**Files:**

- Create: `docs/operations/autonomous-builds.md`
- Modify: `docs/operations/branch-protection.md`
- Modify: `CONTRIBUTING.md`

**Step 1: Write the runbook**

Document:

- the required issue acceptance-criteria format;
- label meanings and lifecycle;
- how to approve, observe, retry, and cancel work;
- draft PR review and merge responsibility;
- hard-stop categories;
- failure receipts and recovery;
- API usage/cost monitoring;
- key rotation and revocation;
- explicit statement that production deployment remains forbidden.

Do not include secret values or manual copy/paste examples that expose them.

**Step 2: Update governance docs**

Add `automation-policy` to the required-check record and explain that the autonomous builder is an implementation participant, not a governance or merge authority.

**Step 3: Run documentation/policy checks**

```bash
node --test .github/automation/validate-autobuild.test.mjs
cd typescript && npm run format:check
```

Expected: pass.

**Step 4: Commit**

```bash
git add docs/operations/autonomous-builds.md docs/operations/branch-protection.md CONTRIBUTING.md
git commit -m "docs: add autonomous build operations runbook"
```

## Task 6: Complete repository configuration safely

**External configuration:**

- GitHub Actions repository secret: `OPENAI_API_KEY`
- Repository labels: `automation-approved`, `automation-in-progress`, `automation-blocked`, `automation-generated`
- Required check: `automation-policy`

**Step 1: Install the key without exposing it**

Use a secret-safe authenticated GitHub path. Never print the value or place it in a command argument, log, issue, PR, artefact, or repository file. If no safe connector/API path is available, stop and ask the owner to complete the GitHub secret form.

**Step 2: Create or verify labels**

Use stable colours/descriptions and do not repurpose unrelated labels.

**Step 3: Verify branch protection**

Confirm existing protection before attempting changes. Add the new check only after it has passed on the branch and `main`; otherwise document the pending owner action.

**Step 4: Commit only documentation changes, if any**

No credentials or external IDs enter git.

## Task 7: Full verification and controlled smoke test

**Step 1: Run all local/static verification available**

```bash
node --test .github/automation/validate-autobuild.test.mjs
cd typescript
npm ci
npm run check
cd jarvis-console-01
npm ci
npm run build
```

Expected: all pass.

**Step 2: Review the complete diff**

Confirm:

- no secret material;
- no production/deployment command;
- no merge command;
- action references are immutable;
- permissions are minimal;
- all untrusted input crosses shell boundaries safely;
- failure cleanup releases the issue lock.

**Step 3: Open a draft implementation PR**

Include the full Copilot Review section and exact verification evidence.

**Step 4: Run a harmless smoke issue**

Create or use an issue whose only requested change is a small documentation/test fixture update with explicit acceptance criteria. Apply `automation-approved` and verify:

1. exactly one run starts;
2. exactly one automation branch is created;
3. exactly one draft PR is opened;
4. normal CI runs independently;
5. no commissioning or deployment occurs;
6. labels and receipts reach their expected terminal state.

**Step 5: Leave merge to the owner**

Do not mark ready, merge, commission, or deploy.

## Security review amendments

Implementation review required the following stronger controls:

- post-agent validation executes from a root-owned immutable copy rather than agent-writable repository code;
- raw control hashes, base SHA, git configuration, assume-unchanged and skip-worktree state are checked;
- untracked files are included in semantic patch scanning;
- an explicit inventory blocks Jarvis authority, authentication, tool-execution, external-effect and governance modules;
- each attempt uses a unique branch;
- verification runs in a separate secret-free job against the exact candidate SHA and publishes commit statuses without relying on recursive pull-request events;
- file and total byte caps apply in addition to line limits.
