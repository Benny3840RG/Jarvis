import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

import { validateQueueAdvanceContract } from "./validate-autobuild.mjs";
import {
  automationIssueNumbers,
  evaluateQueueCandidate,
  parseAutomationIssueRef,
  reconcileLocks,
  selectNextMission,
} from "./select-next-mission.mjs";

const workflow = fs.readFileSync(
  new URL("../workflows/jarvis-queue-advance.yml", import.meta.url),
  "utf8",
);

// --- pure selection module -------------------------------------------------

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
  assert.equal(parseAutomationIssueRef("automation/issue-7/run-gh-abc.def_1"), 7);
  assert.equal(parseAutomationIssueRef("automation/issue-42/run-1/extra"), null);
  assert.equal(parseAutomationIssueRef("feat/issue-42"), null);
  assert.equal(parseAutomationIssueRef("main"), null);
  assert.equal(parseAutomationIssueRef(""), null);
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
    [issue({ body: "no criteria" }), "testable acceptance criteria are missing"],
    [
      issue({ pull_request: { url: "x" } }),
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
    issues: [issue({ number: 30 }), issue({ number: 12 }), issue({ number: 21 })],
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
  const result = selectNextMission({ issues: [issue({ number: 3 })], lockActive: true });
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

test("reconcileLocks releases a lock with no backing candidate", () => {
  const result = reconcileLocks({
    lockedIssueNumbers: [10, 20],
    openAutomationPrHeadRefs: ["automation/issue-20/run-1"],
  });
  assert.deepEqual(result.release, [10]);
  assert.deepEqual(result.held, [20]);
});

test("reconcileLocks releases nothing while a builder run is active", () => {
  const result = reconcileLocks({
    lockedIssueNumbers: [10, 20],
    openAutomationPrHeadRefs: [],
    builderActive: true,
  });
  assert.deepEqual(result.release, []);
  assert.deepEqual(result.held, [10, 20]);
  assert.match(result.reason, /run is active/);
});

test("reconcileLocks is a no-op when no locks are held", () => {
  assert.deepEqual(reconcileLocks({ lockedIssueNumbers: [] }), { release: [], held: [] });
});

// --- workflow contract ---------------------------------------------------

test("queue-advance workflow satisfies the coordinator contract", () => {
  assert.deepEqual(validateQueueAdvanceContract(workflow), { ok: true, reasons: [] });

  assert.equal(
    validateQueueAdvanceContract(
      workflow.replace('workflow_id: "jarvis-autobuild.yml"', 'workflow_id: "deploy.yml"'),
    ).ok,
    false,
    "must dispatch only the bounded builder",
  );
  assert.equal(
    validateQueueAdvanceContract(
      workflow.replace("needs: [verify-main]", "needs: []"),
    ).ok,
    false,
    "advance must depend on verify-main",
  );
  assert.equal(
    validateQueueAdvanceContract(workflow.replace("contents: read", "contents: write")).ok,
    false,
    "must never hold write access to repository contents",
  );
  assert.equal(
    validateQueueAdvanceContract(
      workflow + "\n          await github.rest.pulls.merge({});\n",
    ).ok,
    false,
    "must never merge a pull request",
  );
  assert.equal(
    validateQueueAdvanceContract(workflow.replaceAll("evaluateRevisionHealth", "trustBlindly")).ok,
    false,
    "must evaluate revision health through the shared module",
  );
  assert.equal(
    validateQueueAdvanceContract(
      workflow.replace(
        "inputs: { issue_number: String(issueNumber), source_sha: verifiedSha }",
        "inputs: { issue_number: String(issueNumber) }",
      ),
    ).ok,
    false,
    "must forward the verified revision to the builder",
  );
  assert.equal(
    validateQueueAdvanceContract(workflow.replaceAll("reconcileLocks", "ignoreLocks")).ok,
    false,
    "must reconcile stale mission locks on sweeps",
  );
  assert.equal(
    validateQueueAdvanceContract(
      workflow.replaceAll("getCollaboratorPermissionLevel", "trustTheLabeler"),
    ).ok,
    false,
    "must gate label approvals on the labeler's repository permission",
  );
});

test("all queue-advance actions are pinned to immutable SHAs", () => {
  for (const use of workflow.match(/uses:\s*\S+/g) ?? []) {
    assert.match(use, /@[0-9a-f]{40}$/, use);
  }
});

// --- behavioural: extract and run the github-script bodies --------------

function scriptFor(stepName) {
  const marker = `- name: ${stepName}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `step not found: ${stepName}`);
  const after = workflow.slice(start);
  const body = after.split("          script: |\n")[1];
  assert.ok(body, `no script body for: ${stepName}`);
  const nextStep = body.search(/\n {6}- name: |\n {2}[a-z-]+:\n/);
  const raw = nextStep === -1 ? body : body.slice(0, nextStep);
  return raw
    .split("\n")
    .map((line) => (line.startsWith("            ") ? line.slice(12) : line))
    .join("\n");
}

async function run(stepName, { env = {}, github, core: coreOverrides = {} } = {}) {
  const script = scriptFor(stepName);
  const calls = { setFailed: [], setOutput: {}, comments: [], added: [], removed: [], dispatched: [] };
  const core = {
    info: () => {},
    warning: () => {},
    error: () => {},
    setFailed: (m) => calls.setFailed.push(String(m)),
    setOutput: (k, v) => {
      calls.setOutput[k] = v;
    },
    ...coreOverrides,
  };
  const wrapIssues = (g) => ({
    ...g.rest.issues,
    createComment: async (v) => {
      calls.comments.push(v);
      return g.rest.issues.createComment ? g.rest.issues.createComment(v) : {};
    },
    addLabels: async (v) => {
      calls.added.push(...v.labels);
      return {};
    },
    removeLabel: async (v) => {
      calls.removed.push(v.name);
      if (g.rest.issues.removeLabel) return g.rest.issues.removeLabel(v);
      return {};
    },
  });
  const gh = {
    paginate: async (fn, params) => {
      const out = await fn(params);
      if (!out.data?.workflow_runs) return Array.isArray(out) ? out : out.data;
      const rows = [...out.data.workflow_runs];
      let page = 1;
      while (rows.length < (out.data.total_count ?? rows.length)) {
        const next = await fn({ ...params, page: ++page });
        if (!next.data.workflow_runs.length) break;
        rows.push(...next.data.workflow_runs);
      }
      return rows;
    },
    rest: {
      ...github.rest,
      issues: { ...github.rest.issues, ...(github.rest.issues ? wrapIssues(github) : {}) },
      actions: {
        ...github.rest.actions,
        createWorkflowDispatch: async (v) => {
          calls.dispatched.push(v);
          return {};
        },
      },
    },
  };
  const context = { repo: { owner: "Benny3840RG", repo: "Jarvis" }, serverUrl: "https://github.com" };
  let tick = 0;
  const fakeDate = { now: () => 1_000_000 + tick++ * 200_000 };
  const fakeSetTimeout = (cb) => {
    cb();
    return 0;
  };
  await new Function(
    "context",
    "github",
    "core",
    "process",
    "require",
    "Date",
    "setTimeout",
    `return (async () => {\n${script}\n})();`,
  )(
    context,
    gh,
    core,
    { env: { GITHUB_WORKSPACE: REPO_ROOT, ...env } },
    require,
    fakeDate,
    fakeSetTimeout,
  );
  return calls;
}

const HEALTHY_MAIN_SHA = "a".repeat(40);

function healthyChecks(sha) {
  const tsRun = 111;
  const codeqlRun = 222;
  const ok = (name, run) => ({
    name,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
    id: Math.random(),
    details_url: `https://github.com/Benny3840RG/Jarvis/actions/runs/${run}/job/1`,
  });
  return {
    checks: [
      ok("automation-policy", tsRun),
      ok("typecheck-lint-format-test", tsRun),
      ok("jarvis-console-01-build", tsRun),
      ok("Analyze (actions)", codeqlRun),
      ok("Analyze (python)", codeqlRun),
      ok("Analyze (ruby)", codeqlRun),
      ok("Analyze (javascript-typescript)", codeqlRun),
    ],
    runPaths: {
      [tsRun]: ".github/workflows/typescript.yml",
      [codeqlRun]: "dynamic/github-code-scanning/codeql",
    },
    sha,
  };
}

function verifyMainGithub(fixture) {
  return {
    rest: {
      repos: {
        getBranch: async () => ({ data: { commit: { sha: fixture.sha } } }),
      },
      checks: {
        listForRef: async () => ({ data: fixture.checks }),
      },
      actions: {
        getWorkflowRun: async ({ run_id }) => ({
          data: { path: fixture.runPaths[run_id] ?? "" },
        }),
      },
      issues: { createComment: async () => ({}) },
    },
  };
}

test("verify-main passes when trusted producers report a healthy main", async () => {
  const fixture = healthyChecks(HEALTHY_MAIN_SHA);
  const calls = await run("Verify the current main revision is healthy", {
    env: { EVENT_NAME: "schedule" },
    github: verifyMainGithub(fixture),
  });
  assert.equal(calls.setOutput.verified_sha, HEALTHY_MAIN_SHA);
  assert.deepEqual(calls.setFailed, []);
});

test("verify-main blocks when a required main check failed", async () => {
  const fixture = healthyChecks(HEALTHY_MAIN_SHA);
  fixture.checks.find((c) => c.name === "typecheck-lint-format-test").conclusion = "failure";
  const calls = await run("Verify the current main revision is healthy", {
    env: { EVENT_NAME: "pull_request", MERGED_PR_NUMBER: "470" },
    github: verifyMainGithub(fixture),
  });
  assert.equal(calls.setOutput.verified_sha, undefined);
  assert.equal(calls.setFailed.length, 1);
  assert.match(calls.setFailed[0], /typecheck-lint-format-test:failure/);
  assert.equal(calls.comments.length, 1, "the merged PR is told the queue halted");
});

test("verify-main blocks when an expected CodeQL analysis is missing", async () => {
  const fixture = healthyChecks(HEALTHY_MAIN_SHA);
  fixture.checks = fixture.checks.filter((c) => c.name !== "Analyze (ruby)");
  const calls = await run("Verify the current main revision is healthy", {
    env: { EVENT_NAME: "schedule" },
    github: verifyMainGithub(fixture),
  });
  assert.equal(calls.setOutput.verified_sha, undefined);
  assert.match(calls.setFailed.join(" "), /Timed out.*CodeQL\(ruby\)/s);
});

test("verify-main blocks a CodeQL analysis from an untrusted producer", async () => {
  const fixture = healthyChecks(HEALTHY_MAIN_SHA);
  // Rewrite every Analyze job to point at a non-managed run.
  for (const check of fixture.checks) {
    if (check.name.startsWith("Analyze (")) {
      check.details_url = "https://github.com/Benny3840RG/Jarvis/actions/runs/999/job/1";
    }
  }
  fixture.runPaths[999] = ".github/workflows/impersonator.yml";
  const calls = await run("Verify the current main revision is healthy", {
    env: { EVENT_NAME: "schedule" },
    github: verifyMainGithub(fixture),
  });
  assert.equal(calls.setOutput.verified_sha, undefined);
  assert.match(calls.setFailed.join(" "), /CodeQL\(actions\)/);
});

test("verify-main blocks a required check from an untrusted producer", async () => {
  const fixture = healthyChecks(HEALTHY_MAIN_SHA);
  fixture.runPaths[111] = ".github/workflows/not-typescript.yml";
  const calls = await run("Verify the current main revision is healthy", {
    env: { EVENT_NAME: "schedule" },
    github: verifyMainGithub(fixture),
  });
  assert.match(calls.setFailed.join(" "), /untrusted producer/);
});

// --- behavioural: advance -------------------------------------------------

function advanceGithub({
  verifiedSha = HEALTHY_MAIN_SHA,
  currentSha = HEALTHY_MAIN_SHA,
  approved = [],
  inProgress = [],
  openPulls = [],
  builderRuns = [],
  issueById = {},
} = {}) {
  return {
    rest: {
      repos: { getBranch: async () => ({ data: { commit: { sha: currentSha } } }) },
      issues: {
        listComments: async ({ issue_number }) => ({data:[{
          id:issue_number, user:{login:"github-actions[bot]"},
          body:`<!-- jarvis-autobuild-lock:${issue_number} -->`,
        }]}),
        get: async ({ issue_number }) => ({
          data: issueById[issue_number] ?? { number: issue_number, state: "open", labels: [], body: "" },
        }),
        listForRepo: async ({ labels }) => ({
          data: labels === "automation-approved" ? approved : inProgress,
        }),
        createComment: async () => ({}),
        removeLabel: async () => ({}),
        addLabels: async () => ({}),
      },
      pulls: { list: async () => ({ data: openPulls }) },
      actions: {
        listWorkflowRuns: async () => ({ data: { workflow_runs: builderRuns } }),
        getWorkflowRun: async () => ({data:{status:"completed",conclusion:"success",path:".github/workflows/jarvis-autobuild.yml"}}),
      },
    },
    _verifiedSha: verifiedSha,
  };
}

function approvedIssue(number, overrides = {}) {
  return {
    number,
    state: "open",
    labels: [{ name: "automation-approved" }],
    body: "## Acceptance criteria\n\n- [ ] a\n- [ ] b",
    ...overrides,
  };
}

async function runAdvance(opts) {
  const github = advanceGithub(opts);
  return run("Select and dispatch at most one mission", {
    env: {
      VERIFIED_SHA: github._verifiedSha,
      EVENT_NAME: opts.eventName ?? "schedule",
      MERGED: opts.merged ?? "",
      MERGED_HEAD_REF: opts.mergedHeadRef ?? "",
    },
    github,
  });
}

test("advance dispatches exactly one mission from a multi-issue queue", async () => {
  const approved = [approvedIssue(210), approvedIssue(204), approvedIssue(219)];
  const calls = await runAdvance({ approved, issueById: Object.fromEntries(approved.map((i) => [i.number, i])) });
  assert.equal(calls.dispatched.length, 1);
  assert.equal(calls.dispatched[0].inputs.issue_number, "204");
  assert.equal(calls.dispatched[0].inputs.source_sha, HEALTHY_MAIN_SHA);
});

test("advance dispatches nothing while another mission holds a live lock", async () => {
  const calls = await runAdvance({
    eventName: "issues",
    approved: [approvedIssue(210)],
    inProgress: [{ number: 199, labels: [{ name: "automation-in-progress" }] }],
    issueById: { 210: approvedIssue(210) },
  });
  assert.equal(calls.dispatched.length, 0);
  assert.equal(calls.removed.length, 0, "a non-sweep trigger never reconciles locks");
});

test("advance dispatches nothing while a candidate PR is open", async () => {
  const calls = await runAdvance({
    approved: [approvedIssue(210)],
    openPulls: [
      {
        number: 471,
        head: { ref: "automation/issue-188/run-5", repo: { full_name: "Benny3840RG/Jarvis" } },
      },
    ],
    issueById: { 210: approvedIssue(210) },
  });
  assert.equal(calls.dispatched.length, 0);
});

test("advance dispatches nothing while a builder run is active", async () => {
  const calls = await runAdvance({
    approved: [approvedIssue(210)],
    builderRuns: [{ status: "in_progress" }],
    issueById: { 210: approvedIssue(210) },
  });
  assert.equal(calls.dispatched.length, 0);
});

test("advance skips a blocked issue and takes the next", async () => {
  const approved = [
    approvedIssue(205, { labels: [{ name: "automation-approved" }, { name: "automation-blocked" }] }),
    approvedIssue(208),
  ];
  const calls = await runAdvance({ approved, issueById: Object.fromEntries(approved.map((i) => [i.number, i])) });
  assert.equal(calls.dispatched.length, 1);
  assert.equal(calls.dispatched[0].inputs.issue_number, "208");
});

test("advance aborts when main HEAD moved since verification", async () => {
  const calls = await runAdvance({
    approved: [approvedIssue(210)],
    currentSha: "b".repeat(40),
    issueById: { 210: approvedIssue(210) },
  });
  assert.equal(calls.dispatched.length, 0);
});

test("advance aborts when the chosen issue lost its approval between selection and dispatch", async () => {
  const stale = approvedIssue(210);
  const calls = await runAdvance({
    approved: [stale],
    issueById: { 210: { number: 210, state: "open", labels: [], body: stale.body } },
  });
  assert.equal(calls.dispatched.length, 0);
});

test("advance releases the lock of a merged candidate before selecting", async () => {
  const next = approvedIssue(230);
  const calls = await runAdvance({
    eventName: "pull_request",
    merged: "true",
    mergedHeadRef: "automation/issue-225/run-77",
    approved: [next],
    issueById: { 230: next },
  });
  assert.ok(calls.removed.includes("automation-in-progress"));
  assert.equal(calls.dispatched.length, 1);
  assert.equal(calls.dispatched[0].inputs.issue_number, "230");
});

// --- behavioural: sweep lock reconciliation (missed PR-close recovery) ---

test("a sweep releases a stale lock with no candidate and no active run, then advances", async () => {
  const stale = { number: 190, labels: [{ name: "automation-in-progress" }] };
  const next = approvedIssue(215);
  const calls = await runAdvance({
    eventName: "schedule",
    inProgress: [stale],
    approved: [next],
    issueById: { 215: next },
  });
  assert.ok(calls.removed.includes("automation-in-progress"));
  assert.deepEqual(calls.added, ["automation-blocked"]);
  assert.match(calls.comments[0].body, /stale mission lock/i);
  assert.equal(calls.dispatched.length, 1);
  assert.equal(calls.dispatched[0].inputs.issue_number, "215");
});

test("a sweep keeps a lock whose candidate PR is still open", async () => {
  const held = { number: 191, labels: [{ name: "automation-in-progress" }] };
  const calls = await runAdvance({
    eventName: "schedule",
    inProgress: [held],
    openPulls: [
      {
        number: 480,
        head: { ref: "automation/issue-191/run-2", repo: { full_name: "Benny3840RG/Jarvis" } },
      },
    ],
    approved: [approvedIssue(215)],
    issueById: { 215: approvedIssue(215) },
  });
  assert.deepEqual(calls.added, []);
  assert.equal(calls.removed.length, 0);
  assert.equal(calls.dispatched.length, 0, "the open candidate still holds the queue");
});

test("a sweep keeps every lock while a builder run is active", async () => {
  const calls = await runAdvance({
    eventName: "schedule",
    inProgress: [{ number: 192, labels: [{ name: "automation-in-progress" }] }],
    builderRuns: [{ status: "in_progress" }],
    approved: [approvedIssue(215)],
    issueById: { 215: approvedIssue(215) },
  });
  assert.equal(calls.removed.length, 0);
  assert.equal(calls.dispatched.length, 0);
});

test("a merge trigger does NOT reconcile other locks (only sweeps do)", async () => {
  const calls = await runAdvance({
    eventName: "pull_request",
    merged: "true",
    mergedHeadRef: "automation/issue-300/run-1",
    inProgress: [{ number: 193, labels: [{ name: "automation-in-progress" }] }],
    approved: [],
    issueById: {},
  });
  // The merged mission's own lock is released, but #193's is left untouched.
  assert.deepEqual(calls.added, []);
  assert.equal(calls.dispatched.length, 0, "another lock still blocks the queue");
});

// --- behavioural: pr-close-cleanup -------------------------------------

test("pr-close-cleanup blocks the mission of an unmerged candidate and does not advance", async () => {
  const calls = await run("Block the mission whose candidate was closed unmerged", {
    env: { HEAD_REF: "automation/issue-240/run-9", PR_NUMBER: "472" },
    github: {
      rest: {
        issues: {
          removeLabel: async () => ({}),
          addLabels: async () => ({}),
          createComment: async () => ({}),
        },
      },
    },
  });
  assert.ok(calls.removed.includes("automation-in-progress"));
  assert.deepEqual(calls.added, ["automation-blocked"]);
  assert.equal(calls.dispatched.length, 0);
  assert.match(calls.comments[0].body, /closed without merging/i);
});

test("pr-close-cleanup ignores a non-automation head ref", async () => {
  const calls = await run("Block the mission whose candidate was closed unmerged", {
    env: { HEAD_REF: "feature/unrelated", PR_NUMBER: "473" },
    github: {
      rest: {
        issues: {
          removeLabel: async () => ({}),
          addLabels: async () => ({}),
          createComment: async () => ({}),
        },
      },
    },
  });
  assert.deepEqual(calls.added, []);
  assert.deepEqual(calls.removed, []);
});

// --- simultaneous approvals are queued, not lost ----------------------

test("simultaneous approvals dispatch one worker and leave the rest queued for later", async () => {
  const approved = [approvedIssue(300), approvedIssue(301), approvedIssue(302)];
  const issueById = Object.fromEntries(approved.map((i) => [i.number, i]));

  // First advance: nothing active -> dispatch #300.
  const first = await runAdvance({ approved, issueById });
  assert.equal(first.dispatched[0].inputs.issue_number, "300");

  // Concurrent advances while #300's builder run is live -> no dispatch, none lost.
  const during = await runAdvance({ approved, issueById, builderRuns: [{ status: "queued" }] });
  assert.equal(during.dispatched.length, 0);
  assert.deepEqual(
    approved.map((i) => i.number),
    [300, 301, 302],
    "every approved issue is still in the queue",
  );

  // After #300 merges: its lock is freed and the next lowest is dispatched.
  const afterMerge = await runAdvance({
    eventName: "pull_request",
    merged: "true",
    mergedHeadRef: "automation/issue-300/run-1",
    approved: [approvedIssue(301), approvedIssue(302)],
    issueById,
  });
  assert.equal(afterMerge.dispatched[0].inputs.issue_number, "301");
});

test("a sweep preserves a live run beyond the first history page", async () => {
  const held = {number:190};
  const github = advanceGithub({inProgress:[held]});
  const history = [...Array.from({length:105},(_,i)=>({id:200-i,status:"completed"})), {id:94,status:"in_progress"}];
  github.rest.actions.listWorkflowRuns = async ({per_page=30,page=1}) => ({data:{
    total_count:history.length,workflow_runs:history.slice((page-1)*per_page,page*per_page),
  }});
  const calls = await run("Select and dispatch at most one mission", {
    env:{VERIFIED_SHA:HEALTHY_MAIN_SHA,EVENT_NAME:"schedule"},github,
  });
  assert.deepEqual(calls.removed,[]);
  assert.deepEqual(calls.dispatched,[]);
});

for (const scenario of ["missing", "live", "inaccessible", "wrong-workflow"]) {
  test(`sweep preserves lock with ${scenario} owning-run evidence`, async () => {
    const github = advanceGithub({inProgress:[{number:190}]});
    if (scenario === "missing") github.rest.issues.listComments = async () => ({data:[]});
    else github.rest.actions.getWorkflowRun = async () => {
      if (scenario === "inaccessible") throw new Error("unavailable");
      return {data:{status:scenario === "live" ? "in_progress" : "completed", conclusion:"success",
        path:scenario === "wrong-workflow" ? "other.yml" : ".github/workflows/jarvis-autobuild.yml"}};
    };
    const calls = await run("Select and dispatch at most one mission", {
      env:{VERIFIED_SHA:HEALTHY_MAIN_SHA,EVENT_NAME:"schedule"},github,
    });
    assert.deepEqual(calls.removed,[]);
    assert.deepEqual(calls.dispatched,[]);
  });
}
