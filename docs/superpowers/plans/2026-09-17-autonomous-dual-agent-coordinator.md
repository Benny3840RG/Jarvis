# Autonomous Dual-Agent Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and validate a safe, exact-candidate, dual-agent mission handoff that removes routine owner dispatching without granting merge or deployment authority.

**Architecture:** A pure ESM controller owns validation, phase transitions, role selection, and receipt rendering. Existing queue, builder, CI, and PR-maintenance workflows remain the executable authorities; integration documents the mapping and tests ensure the new record cannot create authority.

**Tech Stack:** Node.js ESM, `node:test`, GitHub Actions YAML, Markdown operations documentation.

**Spec:** `docs/superpowers/specs/2026-09-17-autonomous-dual-agent-coordinator-design.md`

## Global Constraints

- `jarvis-pr-maintenance/review` remains advisory and is not a GitHub approval.
- Receipts are informational; provider workflow history, checks, and durable Development state remain authoritative.
- Require full 40-character lowercase Git SHAs and a 64-character evidence fingerprint.
- Preserve one active mission, exact-head evidence, bounded repairs, and original-builder ownership.
- Never add merge, approval, ready-for-review, deployment, commissioning, issue-close, or branch-protection authority.

---

### Task 1: Pure mission state controller

**Files:**
- Create: `.github/automation/dual-agent-mission.mjs`
- Test: `.github/automation/dual-agent-mission.test.mjs`

**Interfaces:**
- Produces `claimMission(input)`, `advanceMission(current, event)`, and `renderMissionReceipt(mission)`.
- `claimMission` accepts `{issueNumber, baseSha, previousTerminalMission}` and returns a `claimed` mission with complementary builder/reviewer roles only after validating the prior owner-evidenced terminal mission.
- `advanceMission` accepts an exact identity event and returns a new validated phase or throws on stale/authority-expanding input.

- [ ] **Step 1: Write the failing role and exact-identity tests**

```js
const mission = claimMission({ issueNumber: 42, baseSha: "a".repeat(40) });
assert.deepEqual([mission.builder, mission.reviewer], ["codex", "codex-independent"]);
assert.throws(() => claimMission({ issueNumber: 42, baseSha: "short" }), /base SHA/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .github/automation/dual-agent-mission.test.mjs`

Expected: FAIL because `dual-agent-mission.mjs` does not exist.

- [ ] **Step 3: Implement minimal claim validation and complementary role selection**

```js
export function claimMission({ issueNumber, baseSha, previousTerminalMission } = {}) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("Invalid issue number.");
  if (!SHA.test(baseSha)) throw new Error("Invalid base SHA.");
  const builder = previousTerminalMission?.builder === "codex" ? "claude" : "codex";
  return { version: 1, issueNumber, baseSha, builder, reviewer: "codex-independent", phase: "claimed" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test .github/automation/dual-agent-mission.test.mjs`

Expected: PASS.

### Task 2: Phase transitions and safe owner boundary

**Files:**
- Modify: `.github/automation/dual-agent-mission.mjs`
- Modify: `.github/automation/dual-agent-mission.test.mjs`

**Interfaces:**
- `advanceMission(current, event)` consumes `candidate`, `review-started`, `repair-required`, `awaiting-owner`, `terminal`, or `blocked` events.
- Candidate/review events include the exact `{pullNumber, headSha, baseSha, fingerprint}`; repair events must name `current.builder`.

- [ ] **Step 1: Write failing tests for stale evidence, same-builder repair, and no owner authority**

```js
assert.throws(() => advanceMission(waiting, { type: "review-started", ...wrongHead }), /stale/i);
assert.throws(() => advanceMission(reviewing, { type: "repair-required", builder: "claude", ...identity }), /original builder/i);
assert.doesNotMatch(renderMissionReceipt(owner), /merge authorised: yes|deployment authorised: yes/i);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test .github/automation/dual-agent-mission.test.mjs`

Expected: FAIL because transition APIs do not exist.

- [ ] **Step 3: Implement only the allowed transition graph**

```js
const allowed = { claimed: ["candidate", "blocked", "terminal"], "waiting-ci": ["review-started", "blocked", "terminal"], reviewing: ["candidate", "repair-required", "awaiting-owner", "blocked", "terminal"], "repair-required": ["candidate", "blocked", "terminal"], "awaiting-owner": ["terminal"], blocked: ["terminal"] };
```

Validate identity on every candidate-derived transition; increment repair count only through `repair-required`; render explicit `Merge authorised: NO` and `Deployment authorised: NO` lines.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test .github/automation/dual-agent-mission.test.mjs`

Expected: PASS.

### Task 3: Coordinator-facing operations record

**Files:**
- Modify: `docs/operations/dual-agent-coordination.md`
- Modify: `docs/operations/autonomous-builds.md`
- Test: `.github/automation/dual-agent-mission.test.mjs`

**Interfaces:**
- The documented receipt is non-authoritative, binds the phase to exact identity, routes repairs to the same builder, and lists the three owner interrupts only.

- [ ] **Step 1: Write failing documentation/receipt assertions**

```js
assert.match(renderMissionReceipt(owner), /Owner interrupts: merge approval, deployment approval, or blocked ambiguity\/risk/);
assert.match(renderMissionReceipt(owner), /Review: advisory/);
```

- [ ] **Step 2: Run focused test to verify it fails**

Run: `node --test .github/automation/dual-agent-mission.test.mjs`

Expected: FAIL because the receipt lacks the required policy copy.

- [ ] **Step 3: Update the controller receipt and operation docs**

Document the phase-to-existing-workflow mapping, the unavailable-Claude stop condition, and the fact that the receipt supplements—not replaces—the queue lock, PR evidence, and durable Development authority.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test .github/automation/dual-agent-mission.test.mjs`

Expected: PASS.

### Task 4: Regression and maintained gates

**Files:**
- Test: `.github/automation/validate-autobuild.test.mjs`
- Test: `.github/automation/pr-maintenance-workflow.test.mjs`

- [ ] **Step 1: Add failing contract assertions that review stays advisory and workflows gain no owner authority**

```js
assert.match(prMaintenance, /advisory/i);
assert.doesNotMatch(queue, /pulls\.merge|enablePullRequestAutoMerge|deploy/i);
```

- [ ] **Step 2: Run focused workflow tests to verify failure**

Run: `node --test .github/automation/dual-agent-mission.test.mjs .github/automation/validate-autobuild.test.mjs .github/automation/pr-maintenance-workflow.test.mjs`

Expected: FAIL only until the added contract expectations are satisfied.

- [ ] **Step 3: Keep workflow permissions unchanged and make any necessary test-only contract update**

No workflow mutation is permitted unless required to invoke an existing safe controller; prefer documentation and pure-controller coverage for this first increment.

- [ ] **Step 4: Run focused and maintained full checks**

Run: `node --test .github/automation/dual-agent-mission.test.mjs .github/automation/validate-autobuild.test.mjs .github/automation/pr-maintenance-workflow.test.mjs && npm run check`

Working directory for full check: `typescript/`

Expected: all focused tests and the maintained full gate pass.
