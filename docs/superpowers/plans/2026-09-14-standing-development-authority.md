# Standing Development Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary Jarvis Development work self-driving through build, retry, repair, checks and independent review while keeping control-plane, merge and deployment authority owner-controlled.

**Architecture:** Keep the existing durable Development admission and PR-maintenance machinery. Replace per-issue-only uncertainty configuration with a standing `0.05` authority envelope plus optional overrides, narrow the diff deny-list to actual control-plane files instead of broad application areas, and make pre-publication operational failures retry automatically within a finite budget while hard guard failures still block and produce an automatic Claude advisory handoff.

**Tech Stack:** GitHub Actions YAML, Node.js ESM automation helpers/tests, existing Jarvis Development/Convex authority boundary.

**Spec:** `docs/superpowers/specs/2026-09-14-standing-development-authority-design.md`

## Global Constraints

- Standing ordinary Development uncertainty budget: `0.05`.
- Issue-specific budget remains an optional highest-priority override.
- Repository-wide `JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET` remains an optional override of the built-in `0.05`.
- No autonomous merge authority.
- No autonomous production deployment or commissioning authority.
- `.github/workflows/`, `.github/actions/`, `.github/automation/`, dependency manifests, secret/env material, schema/config authority and deployment/governance controls remain forbidden to unattended workers.
- Exact-head CI and independent Jarvis review remain required before owner merge.

---

### Task 1: Standing uncertainty budget

**Files:**
- Modify: `.github/automation/development-workflow.test.mjs`
- Modify: `.github/workflows/jarvis-autobuild.yml`
- Modify: `docs/operations/pr-maintenance.md`

**Interfaces:**
- Consumes: existing `JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET` environment consumed by `run-development-actions.mjs`.
- Produces: resolved workflow value using issue-specific override, repository-wide override, then literal `0.05`.

- [ ] **Step 1: Write the failing workflow-contract test**

Replace the existing test that forbids a repository-wide fallback with assertions that the mission environment contains all three levels in this order:

```js
test("admission uses issue override, standing repository budget, then owner-approved 0.05", () => {
  const mission = build.split("\n  mission:")[1].split("\n  supervise:")[0];
  assert.match(
    mission,
    /vars\[format\('JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_\{0\}', inputs\.issue_number\)\]/,
  );
  assert.match(mission, /vars\.JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET/);
  assert.match(mission, /'0\.05'/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test .github/automation/development-workflow.test.mjs
```

Expected: the new standing-budget test fails because current workflow uses only the issue-specific variable.

- [ ] **Step 3: Implement the minimal workflow expression**

Set the mission environment to:

```yaml
JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET: ${{ vars[format('JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_{0}', inputs.issue_number)] || vars.JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET || '0.05' }}
```

Do not change `run-development-actions.mjs`; durable admission continues to validate the resolved numeric value.

- [ ] **Step 4: Update operator documentation**

Document that `0.05` is the owner-approved standing Development envelope, with repository-wide and issue-specific override order. Remove wording that says no repository-wide fallback exists.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test .github/automation/development-workflow.test.mjs
```

Expected: PASS.

---

### Task 2: Allow ordinary application-code repairs while locking the control plane

**Files:**
- Modify: `.github/automation/validate-autobuild.test.mjs`
- Modify: `.github/automation/validate-autobuild.mjs`

**Interfaces:**
- Consumes: `evaluateDiff({files})` and `evaluatePatch(patch)`.
- Produces: path policy that permits ordinary application implementation areas while preserving immutable automation/dependency/schema/deployment controls and semantic authority scanning.

- [ ] **Step 1: Add failing acceptance tests for previously impossible repair paths**

Add one test with source+matching-test pairs covering:

```text
typescript/convex/externalReconciliations.ts
typescript/src/persistence/convexExternalReconciliations.ts
typescript/src/reconciliation/reconciliationWorker.ts
typescript/src/integrations/outlookAdapter.ts
```

The test must assert `evaluateDiff(...).ok === true` when no authority-sensitive patch content is involved.

- [ ] **Step 2: Keep explicit locked-control tests**

The forbidden-path test must continue to reject at least:

```text
.github/workflows/evil.yml
.github/automation/validate-autobuild.mjs
.env.local
typescript/package.json
typescript/package-lock.json
typescript/convex/schema.ts
convex.json
typescript/src/deployment/production.ts
docs/governance/README.md
docs/deployment.md
```

The existing `evaluatePatch` authority-sensitive tests stay intact.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
node --test .github/automation/validate-autobuild.test.mjs
```

Expected: new ordinary-application-path test fails on the current blanket deny-list.

- [ ] **Step 4: Narrow `FORBIDDEN_PATHS`**

Remove blanket application-area patterns for integration/provider/reconciliation/external/persistence and equivalent ordinary source areas. Preserve immutable automation, dependency, schema/config, deployment/commissioning and governance controls. Do not weaken size, binary, symlink, matching-test or semantic patch guards.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
node --test .github/automation/validate-autobuild.test.mjs
```

Expected: PASS including the locked-control and authority-sensitive content regressions.

---

### Task 3: Finite automatic retry instead of instant owner babysitting

**Files:**
- Modify: `.github/automation/validate-autobuild.test.mjs`
- Modify: `.github/workflows/jarvis-autobuild.yml`

**Interfaces:**
- Consumes: finalizer stage outcomes, issue comments and `automation-in-progress` / `automation-blocked` labels.
- Produces: bounded retry comments using marker `<!-- jarvis-autobuild-auto-retry:v1 -->`; hard failures still block.

- [ ] **Step 1: Write failing finalizer tests**

Extend the existing `runFinalize()` fixture so `github.paginate()` can return prior issue comments. Add tests proving:

1. first and second pre-publication worker/dependency failures release the mission without adding `automation-blocked` and publish the retry marker;
2. the third equivalent failure adds `automation-blocked`;
3. a post-agent `guard === failure` blocks immediately regardless of retry count;
4. a hard-block comment contains `@claude` plus the sanitized stage summary so the read-only alternate reviewer is invoked automatically;
5. a run that never acquired the lock remains untouched as today.

Use a finite retry limit of **2 automatic retries** after the initial failed attempt.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test .github/automation/validate-autobuild.test.mjs
```

Expected: current finalizer fails because it always applies `automation-blocked` after an owned failure.

- [ ] **Step 3: Implement minimal finalizer classification**

Inside the trusted finalizer script:

- count existing bot comments containing `<!-- jarvis-autobuild-auto-retry:v1 -->`;
- classify `GUARD_OUTCOME === "failure"` as hard block;
- classify owned pre-publication dependency/worker failure as retryable while prior retry markers `< 2`;
- on retryable failure, remove `automation-in-progress`, do not add `automation-blocked`, and publish a retry marker/comment so the queue can pick the still-approved issue again;
- on hard block or exhausted retries, add `automation-blocked` and post one sanitized `@claude` advisory request containing run URL and stage outcomes;
- never grant Claude write, approval, merge or deployment authority.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test .github/automation/validate-autobuild.test.mjs
```

Expected: PASS.

---

### Task 4: Full control-plane verification

**Files:**
- No new production files.

- [ ] **Step 1: Run all automation policy tests**

```bash
node --test .github/automation/*.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run maintained repository checks**

```bash
npm run check --prefix typescript
npm run build --prefix typescript/jarvis-console-01
```

Expected: PASS.

- [ ] **Step 3: Inspect the final diff**

Confirm no autonomous merge/deploy path was introduced, no secret/permission scope was expanded beyond what the finalizer already requires, and the autonomous worker still cannot modify `.github` controls itself.

- [ ] **Step 4: Push the candidate and require exact-head CI plus independent Jarvis review**

The PR remains unmerged until required checks pass and `jarvis-pr-maintenance/review` reports PASS on the exact current head.
