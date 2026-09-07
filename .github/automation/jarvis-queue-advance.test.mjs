import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  automationIssueNumbers,
  evaluateQueueCandidate,
  parseAutomationIssueRef,
  selectNextMission,
} from "./select-next-mission.mjs";

const workflow = fs.readFileSync(
  new URL("../workflows/jarvis-queue-advance.yml", import.meta.url),
  "utf8",
);

function issue(overrides = {}) {
  return {
    number: 100,
    state: "open",
    labels: ["automation-approved"],
    body: "## Acceptance criteria\n\n- [ ] Do the thing\n- [ ] Test the thing",
    ...overrides,
  };
}

test("parseAutomationIssueRef extracts issue numbers only from attempt refs", () => {
  assert.equal(parseAutomationIssueRef("automation/issue-42/run-123456"), 42);
  assert.equal(
    parseAutomationIssueRef("automation/issue-7/run-gh-abc.def_1"),
    7,
  );
  assert.equal(parseAutomationIssueRef("automation/issue-42/run-1/extra"), null);
  assert.equal(parseAutomationIssueRef("feat/issue-42"), null);
  assert.equal(parseAutomationIssueRef("main"), null);
  assert.equal(parseAutomationIssueRef(""), null);
  assert.equal(parseAutomationIssueRef(undefined), null);
});

test("automationIssueNumbers collapses head refs to a set", () => {
  const numbers = automationIssueNumbers([
    "automation/issue-1/run-a",
    "automation/issue-1/run-b",
    "automation/issue-2/run-c",
    "chore/unrelated",
  ]);
  assert.deepEqual([...numbers].sort((a, b) => a - b), [1, 2]);
});

test("evaluateQueueCandidate accepts a clean approved issue", () => {
  assert.deepEqual(evaluateQueueCandidate(issue()), { ok: true, reasons: [] });
});

test("evaluateQueueCandidate rejects every ineligible state", () => {
  const cases = [
    [issue({ state: "closed" }), "issue is not open"],
    [issue({ labels: [] }), "automation-approved label is missing"],
    [
      issue({ labels: ["automation-approved", "automation-blocked"] }),
      "automation-blocked label is present",
    ],
    [
      issue({ labels: ["automation-approved", "automation-in-progress"] }),
      "automation-in-progress lock is already present",
    ],
    [
      issue({ body: "no acceptance criteria here" }),
      "testable acceptance criteria are missing",
    ],
    [
      issue({ pull_request: { url: "https://example.invalid/pr/1" } }),
      "target is a pull request, not an issue",
    ],
  ];
  for (const [candidate, expected] of cases) {
    const result = evaluateQueueCandidate(candidate);
    assert.equal(result.ok, false, expected);
    assert.ok(result.reasons.includes(expected), `${expected} :: ${result.reasons}`);
  }
});

test("evaluateQueueCandidate rejects an issue that already has an automation PR", () => {
  const result = evaluateQueueCandidate(issue({ number: 55 }), {
    openAutomationIssueNumbers: new Set([55]),
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("an automation pull request already exists"));
});

test("selectNextMission picks the lowest-numbered eligible issue", () => {
  const result = selectNextMission({
    issues: [
      issue({ number: 30 }),
      issue({ number: 12 }),
      issue({ number: 21 }),
    ],
  });
  assert.equal(result.blocked, false);
  assert.equal(result.issue.number, 12);
});

test("selectNextMission skips ineligible issues and reports why", () => {
  const result = selectNextMission({
    issues: [
      issue({ number: 5, labels: ["automation-approved", "automation-blocked"] }),
      issue({ number: 9, body: "missing criteria" }),
      issue({ number: 14 }),
    ],
  });
  assert.equal(result.issue.number, 14);
  assert.deepEqual(
    result.skipped.map((entry) => entry.number).sort((a, b) => a - b),
    [5, 9],
  );
});

test("selectNextMission dispatches nothing while a lock is held", () => {
  const result = selectNextMission({
    issues: [issue({ number: 3 })],
    lockActive: true,
  });
  assert.equal(result.blocked, true);
  assert.equal(result.issue, null);
});

test("selectNextMission dispatches nothing while an automation PR is open", () => {
  const result = selectNextMission({
    issues: [issue({ number: 3 })],
    openAutomationPrHeadRefs: ["automation/issue-8/run-999"],
  });
  assert.equal(result.blocked, true);
  assert.equal(result.issue, null);
});

test("selectNextMission returns no issue when the queue is drained", () => {
  const result = selectNextMission({ issues: [] });
  assert.equal(result.blocked, false);
  assert.equal(result.issue, null);
});

test("queue-advance workflow only dispatches the bounded builder", () => {
  // Triggers: merge events, a recovery sweep, and manual runs.
  assert.match(workflow, /pull_request:\s*\n\s*types:\s*\[closed\]/);
  assert.match(workflow, /schedule:\s*\n[\s\S]*?-\s*cron:/);
  assert.match(workflow, /workflow_dispatch:/);

  // One advance at a time, never cancelled mid-flight, finite runtime.
  assert.match(
    workflow,
    /group:\s*jarvis-queue-advance-\$\{\{\s*github\.repository\s*\}\}/,
  );
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /timeout-minutes:\s*[1-9]\d*/);

  // It dispatches jarvis-autobuild.yml and does nothing stronger.
  assert.match(workflow, /workflow_id:\s*"jarvis-autobuild\.yml"/);
  assert.match(workflow, /createWorkflowDispatch/);
  assert.doesNotMatch(workflow, /\bmergePull\b|\.merge\(|pulls\.merge/);
  assert.doesNotMatch(workflow, /createReview|submitReview|approveWorkflowRun/);
  assert.doesNotMatch(workflow, /\b(?:deploy|commission)\b/i);

  // Never grants write to repository contents.
  assert.doesNotMatch(workflow, /contents:\s*write/);

  // The merge path is gated on a real, labelled autonomous-build merge.
  assert.match(workflow, /github\.event\.pull_request\.merged\s*==\s*true/);
  assert.match(workflow, /'automation-generated'/);

  // Post-merge CI is verified on the merge commit before advancing.
  assert.match(workflow, /verify-post-merge:/);
  assert.match(workflow, /merge_commit_sha/);
  assert.match(workflow, /github\.rest\.checks\.listForRef/);
  assert.match(workflow, /needs:\s*\[verify-post-merge\]/);

  // Actions are pinned to immutable commit SHAs.
  for (const pin of workflow.match(/uses:\s*[^\s]+/g) ?? []) {
    assert.match(pin, /@[0-9a-f]{40}$/, pin);
  }

  // The selection module is loaded from the trusted base branch only.
  assert.match(workflow, /ref:\s*main/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /select-next-mission\.mjs/);

  // The lock-acquisition race is closed by also checking for a live builder run.
  assert.match(workflow, /listWorkflowRuns/);
  assert.match(workflow, /lockActive:\s*lockActive\s*\|\|\s*builderActive/);
});

test("autobuild eligibility still gates internal dispatch on the approved label", () => {
  const autobuild = fs.readFileSync(
    new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
    "utf8",
  );
  const eligibilityStart = autobuild.indexOf("id: eligibility");
  const eligibilityEnd = autobuild.indexOf(
    "- name: Require the OpenAI Actions secret",
  );
  const eligibility = autobuild.slice(eligibilityStart, eligibilityEnd);

  // The collaborator lookup may be skipped only for a github-actions[bot]
  // workflow_dispatch (the queue-advance re-dispatch), never for a human run.
  assert.match(eligibility, /internalDispatch/);
  assert.match(
    eligibility,
    /EVENT_NAME === "workflow_dispatch"[\s\S]*TRIGGER_ACTOR === "github-actions\[bot\]"/,
  );
  // The label gate is unconditional and still present.
  assert.match(eligibility, /automation-approved label is missing/);
  assert.match(eligibility, /labels\.has\("automation-approved"\)/);
  // The lock and existing-PR gates are unconditional too.
  assert.match(eligibility, /automation-in-progress lock is already present/);
  assert.match(eligibility, /an automation pull request already exists/);
});

test("TypeScript CI runs the queue-advance policy tests", () => {
  const ci = fs.readFileSync(
    new URL("../workflows/typescript.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    ci,
    /node --test[\s\S]*\.github\/automation\/jarvis-queue-advance\.test\.mjs/,
  );
  assert.match(ci, /\.github\/workflows\/jarvis-queue-advance\.yml/);
});
