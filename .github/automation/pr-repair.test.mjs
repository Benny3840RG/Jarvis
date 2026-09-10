import assert from "node:assert/strict";
import test from "node:test";
import { validateRepair, repairRunName } from "./pr-repair.mjs";
const sha = "a".repeat(40);
const fixture = () => ({
  issue: {
    number: 12,
    state: "open",
    labels: [{ name: "automation-approved" }],
  },
  pull: {
    number: 34,
    state: "open",
    labels: [{ name: "automation-generated" }],
    base: { ref: "main" },
    head: {
      sha,
      ref: "automation/issue-12/run-55",
      repo: { full_name: "owner/repo" },
    },
  },
  repository: "owner/repo",
  issueNumber: 12,
  pullNumber: 34,
  expectedHead: sha,
});
test("repair binds existing approved same-repository candidate and exact SHA", () => {
  assert.equal(validateRepair(fixture()), "automation/issue-12/run-55");
  for (const mutate of [
    (x) => (x.pull.head.sha = "b".repeat(40)),
    (x) => (x.pull.head.repo.full_name = "fork/repo"),
    (x) => (x.pull.labels = []),
    (x) => (x.issue.labels = []),
    (x) => (x.pull.state = "closed"),
    (x) => (x.pull.head.ref = "automation/issue-13/run-55"),
    (x) => (x.expectedHead = "main"),
    (x) => (x.pull.base.ref = "other"),
  ]) {
    const x = fixture();
    mutate(x);
    assert.throws(() => validateRepair(x));
  }
});
test("stable run name is specific to positive PR identity", () => {
  assert.equal(repairRunName(34), "Jarvis repair PR #34");
  assert.throws(() => repairRunName(0));
});

import {
  listRepairRuns,
  requireRepairBudget,
  guardCumulative,
} from "./pr-repair.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const run = (id, extra = {}) => ({
  id,
  display_title: repairRunName(34),
  run_attempt: 1,
  path: ".github/workflows/jarvis-autobuild.yml",
  head_branch: "main",
  event: "workflow_dispatch",
  ...extra,
});
const api = (pages) => ({
  rest: {
    pulls: {
      get: async () => ({
        data: { number: 34, created_at: "2026-09-10T00:00:00Z" },
      }),
    },
    actions: {
      listWorkflowRuns: async ({ page }) => ({ data: pages[page - 1] }),
    },
  },
});
test("counts failed and cancelled owning runs, rejects third attempt and reruns", async () => {
  for (const conclusion of ["failure", "cancelled"]) {
    const runs = [run(1, { conclusion }), run(2)];
    await requireRepairBudget({
      github: api([{ total_count: 2, workflow_runs: runs }]),
      owner: "o",
      repo: "r",
      pullNumber: 34,
      runId: 2,
    });
    await assert.rejects(
      requireRepairBudget({
        github: api([{ total_count: 3, workflow_runs: [...runs, run(3)] }]),
        owner: "o",
        repo: "r",
        pullNumber: 34,
        runId: 3,
      }),
    );
  }
  for (const extra of [
    { run_attempt: 2 },
    { head_branch: "evil" },
    { path: "evil.yml" },
  ])
    await assert.rejects(
      requireRepairBudget({
        github: api([{ total_count: 1, workflow_runs: [run(1, extra)] }]),
        owner: "o",
        repo: "r",
        pullNumber: 34,
        runId: 1,
      }),
    );
});
test("repair budget fails closed missing, truncated and duplicate pagination", async () => {
  for (const page of [
    { total_count: 1001, workflow_runs: [] },
    { total_count: 2, workflow_runs: [run(1)] },
    { total_count: 2, workflow_runs: [run(1), run(1)] },
  ])
    await assert.rejects(
      listRepairRuns({
        github: api([page]),
        owner: "o",
        repo: "r",
        pullNumber: 34,
      }),
    );
  await assert.rejects(
    requireRepairBudget({
      github: api([{ total_count: 0, workflow_runs: [] }]),
      owner: "o",
      repo: "r",
      pullNumber: 34,
      runId: 1,
    }),
  );
});
test("cumulative guard rejects pre-existing forbidden changes even when repair delta is harmless", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-guard-"));
  const previous = process.cwd();
  const git = (...args) =>
    execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".github/workflows/build.yml"), "safe\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    fs.writeFileSync(
      path.join(root, ".github/workflows/build.yml"),
      "unsafe\n",
    );
    git("add", ".");
    git("commit", "-qm", "candidate");
    const head = git("rev-parse", "HEAD");
    process.chdir(root);
    assert.throws(
      () => guardCumulative(base, head),
      /Cumulative candidate guard rejected/,
    );
    fs.writeFileSync(path.join(root, "notes.md"), "harmless repair\n");
    assert.throws(
      () => guardCumulative(base, head, true),
      /Cumulative candidate guard rejected/,
    );
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import { validateWorkflowContract } from "./validate-autobuild.mjs";
test("workflow repair contract preserves trusted preparation, cumulative guards, exact head and same PR", () => {
  const workflow = fs.readFileSync(
    new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
    "utf8",
  );
  assert.equal(validateWorkflowContract(workflow).ok, true);
  for (const [before, after] of [
    ["await requireRepairBudget({...args, runId:context.runId});", ""],
    ["await readRepair(args);", ""],
    [
      "guardCumulative(fs.readFileSync('/opt/jarvis-autobuild/main.sha'",
      "removedGuard(fs.readFileSync('/opt/jarvis-autobuild/main.sha'",
    ],
    [
      "sudo install -o root -g root -m 0444 .github/automation/pr-repair.mjs /opt/jarvis-autobuild/pr-repair.mjs",
      "",
    ],
    ["&& github.ref == 'refs/heads/main'", ""],
    ["/usr/bin/git push origin", "/usr/bin/git push --force origin"],
  ])
    assert.equal(
      validateWorkflowContract(workflow.replaceAll(before, after)).ok,
      false,
      before,
    );
  const checkout = workflow.indexOf(
    "      - name: Guard cumulative candidate before checkout",
  );
  const dependencies = workflow.indexOf(
    "      - name: Install locked dependencies before sandboxing",
  );
  assert.ok(dependencies < checkout);
});

import { readRepair } from "./pr-repair.mjs";
test("repair requires original branch run from trusted owning workflow on main", async () => {
  const input = fixture();
  const github = {
    rest: {
      issues: { get: async () => ({ data: input.issue }) },
      pulls: { get: async () => ({ data: input.pull }) },
      actions: {
        getWorkflowRun: async () => ({
          data: run(55, {
            status: "completed",
            display_title: "Jarvis build issue #12",
            head_repository: { full_name: "owner/repo" },
          }),
        }),
      },
    },
  };
  const args = {
    github,
    owner: "owner",
    repo: "repo",
    issueNumber: 12,
    pullNumber: 34,
    expectedHead: sha,
  };
  assert.equal((await readRepair(args)).branch, input.pull.head.ref);
  for (const extra of [
    { head_branch: "evil" },
    { display_title: "Jarvis build issue #99" },
    { display_title: "Jarvis repair PR #34" },
    { run_attempt: 2 },
    { path: "evil.yml" },
    { status: "in_progress" },
    { head_repository: { full_name: "fork/repo" } },
  ]) {
    github.rest.actions.getWorkflowRun = async () => ({
      data: run(55, {
        status: "completed",
        display_title: "Jarvis build issue #12",
        head_repository: { full_name: "owner/repo" },
        ...extra,
      }),
    });
    await assert.rejects(readRepair(args));
  }
});

test("staged new repair files count toward the cumulative candidate budget", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-budget-"));
  const previous = process.cwd();
  const git = (...args) =>
    execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    fs.writeFileSync(path.join(root, "README.md"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    for (let i = 0; i < 16; i++)
      fs.writeFileSync(path.join(root, `note-${i}.md`), "candidate\n");
    git("add", ".");
    git("commit", "-qm", "candidate");
    const head = git("rev-parse", "HEAD");
    process.chdir(root);
    assert.doesNotThrow(() => guardCumulative(base, head));
    for (let i = 16; i < 31; i++)
      fs.writeFileSync(path.join(root, `note-${i}.md`), "repair\n");
    git("-c", "core.hooksPath=/dev/null", "add", "--all");
    assert.throws(
      () => guardCumulative(base, head, true),
      /Cumulative candidate guard rejected/,
    );
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repair history starts at trusted PR creation and validates stable complete pages", async () => {
  const github = api([{ total_count: 0, workflow_runs: [] }]);
  github.rest.actions.listWorkflowRuns = async (args) => {
    assert.equal(args.created, ">=2026-09-10T00:00:00Z");
    return { data: { total_count: 0, workflow_runs: [] } };
  };
  assert.deepEqual(
    await listRepairRuns({ github, owner: "o", repo: "r", pullNumber: 34 }),
    [],
  );
  const first = Array.from({ length: 100 }, (_, i) => run(i + 1));
  for (const pages of [
    [{ total_count: -1, workflow_runs: [] }],
    [
      { total_count: 101, workflow_runs: first },
      { total_count: 102, workflow_runs: [run(101), run(102)] },
    ],
    [
      { total_count: 101, workflow_runs: first },
      { total_count: 101, workflow_runs: [run(1)] },
    ],
    [{ total_count: 0, workflow_runs: [run(1)] }],
  ])
    await assert.rejects(
      listRepairRuns({
        github: api(pages),
        owner: "o",
        repo: "r",
        pullNumber: 34,
      }),
    );
  for (const created_at of [undefined, "yesterday", "2026-02-30T00:00:00Z"]) {
    const invalid = api([]);
    invalid.rest.pulls.get = async () => ({ data: { number: 34, created_at } });
    await assert.rejects(
      listRepairRuns({
        github: invalid,
        owner: "o",
        repo: "r",
        pullNumber: 34,
      }),
    );
  }
});
