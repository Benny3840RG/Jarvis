import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseReview,
  evaluateCandidateChecks,
  maintenanceDisposition,
  collectReviewContext,
} from "./pr-maintenance.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const review = {
  verdict: "pass",
  summary: "No concrete defect found.",
  findings: [],
};

test("review output is advisory strict data, never an authority command", () => {
  assert.deepEqual(parseReview(JSON.stringify(review)), review);
  for (const value of [
    { ...review, merge: true },
    { ...review, verdict: "approved" },
    {
      ...review,
      findings: [{ file: "a.ts", line: 1, severity: "high", message: "Bug" }],
    },
    { ...review, summary: "" },
    { ...review, findings: null },
  ])
    assert.throws(() => parseReview(JSON.stringify(value)));
  assert.throws(() => parseReview("```json\n{}\n```"));
  assert.throws(() => parseReview("x".repeat(32_769)));
});

function checks() {
  const names = [
    "automation-policy",
    "typecheck-lint-format-test",
    "jarvis-console-01-build",
    "pr-evidence",
    "Analyze (actions)",
    "Analyze (python)",
    "Analyze (ruby)",
    "Analyze (javascript-typescript)",
  ];
  const runs = new Map();
  const items = names.map((name, index) => {
    const id = index + 1;
    runs.set(id, {
      id,
      head_sha: head,
      event: "pull_request",
      pull_requests: [{ number: 490, head: { sha: head } }],
      path:
        name === "pr-evidence"
          ? ".github/workflows/copilot-check.yml"
          : name.startsWith("Analyze")
            ? "dynamic/github-code-scanning/codeql"
            : ".github/workflows/typescript.yml",
    });
    return {
      id,
      name,
      head_sha: head,
      app: { slug: "github-actions" },
      status: "completed",
      conclusion: "success",
      details_url: `https://github.com/owner/repo/actions/runs/${id}`,
    };
  });
  return { checkRuns: items, runs, headSha: head };
}

test("candidate CI requires exact head, trusted workflow and all required checks", () => {
  assert.equal(evaluateCandidateChecks(checks()).ok, true);
  for (const mutate of [
    (x) => {
      x.checkRuns.pop();
    },
    (x) => {
      x.checkRuns[0].conclusion = "neutral";
    },
    (x) => {
      x.checkRuns[0].conclusion = "skipped";
    },
    (x) => {
      x.checkRuns[0].head_sha = base;
    },
    (x) => {
      x.runs.get(1).head_sha = base;
    },
    (x) => {
      x.runs.get(1).event = "workflow_dispatch";
    },
    (x) => {
      x.runs.get(1).path = ".github/workflows/forged.yml";
    },
    (x) => {
      x.checkRuns[0].app.slug = "attacker";
    },
  ]) {
    const value = checks();
    mutate(value);
    assert.equal(evaluateCandidateChecks(value).ok, false);
  }
});

test("only failed verification or concrete review findings can request a bounded repair", () => {
  const input = {
    ci: { ok: true, problems: [], pending: [] },
    review,
    repairEligible: true,
    repairCount: 0,
  };
  assert.equal(maintenanceDisposition(input), "awaiting-owner");
  assert.equal(
    maintenanceDisposition({
      ...input,
      ci: { ok: false, problems: [], pending: ["checks"] },
    }),
    "waiting-ci",
  );
  const failure = {
    ...input,
    ci: { ok: false, problems: ["tests:failure"], pending: [] },
  };
  assert.equal(maintenanceDisposition(failure), "repair");
  assert.equal(
    maintenanceDisposition({ ...failure, repairCount: 2 }),
    "blocked",
  );
  assert.equal(
    maintenanceDisposition({ ...failure, repairEligible: false }),
    "owner-repair-required",
  );
  assert.equal(
    maintenanceDisposition({
      ...input,
      review: { ...review, verdict: "blocked" },
    }),
    "blocked",
  );
});

test("review context uses complete exact-revision file contents and fails closed on omissions", async () => {
  const calls = [];
  const github = {
    rest: {
      repos: {
        getContent: async (args) => {
          calls.push(args);
          return {
            data: {
              type: "file",
              encoding: "base64",
              size: 4,
              content: Buffer.from("code").toString("base64"),
            },
          };
        },
      },
    },
  };
  const input = {
    github,
    owner: "owner",
    repo: "repo",
    headSha: head,
    baseSha: base,
    files: [{ filename: "a.ts", status: "modified" }],
    changedFiles: 1,
  };
  const context = await collectReviewContext(input);
  assert.equal(context[0].before, "code");
  assert.equal(context[0].after, "code");
  assert.deepEqual(
    calls.map((x) => x.ref),
    [base, head],
  );
  await assert.rejects(() =>
    collectReviewContext({ ...input, changedFiles: 2 }),
  );
  await assert.rejects(() =>
    collectReviewContext({
      ...input,
      files: [{ filename: "a.ts", status: "unknown" }],
    }),
  );
  github.rest.repos.getContent = async () => ({
    data: { type: "symlink", target: "secret" },
  });
  await assert.rejects(() => collectReviewContext(input));
});

test("real GitHub dynamic scanning checks bind the PR ref and ignore separate code-quality analyses", () => {
  const fixture = checks();
  fixture.pullNumber = 490;
  for (const run of fixture.runs.values())
    run.pull_requests = [{ number: 490, head: { sha: head } }];
  for (const run of fixture.runs.values())
    if (run.path.startsWith("dynamic/"))
      Object.assign(run, {
        event: "dynamic",
        head_branch: "refs/pull/490/head",
        pull_requests: [],
      });
  for (const [i, language] of [
    "python",
    "ruby",
    "javascript-typescript",
  ].entries()) {
    const id = 100 + i;
    fixture.runs.set(id, {
      id,
      path: "dynamic/github-code-quality/codeql",
      event: "dynamic",
      head_sha: head,
      head_branch: "refs/pull/490/head",
      pull_requests: [],
    });
    fixture.checkRuns.push({
      id,
      name: `Analyze (${language})`,
      head_sha: head,
      app: { slug: "github-actions" },
      status: "completed",
      conclusion: "failure",
      details_url: `https://github.com/owner/repo/actions/runs/${id}`,
    });
  }
  assert.equal(evaluateCandidateChecks(fixture).ok, true);
  fixture.checkRuns = fixture.checkRuns.filter((c) => c.id !== 6);
  assert.equal(
    evaluateCandidateChecks(fixture).ok,
    false,
    "quality cannot replace scanning python check",
  );
});
test("dynamic scanning rejects another PR ref and dynamic TypeScript producers", () => {
  for (const mutate of [
    (x) => (x.runs.get(5).head_branch = "refs/pull/491/head"),
    (x) => (x.runs.get(5).head_branch = "main"),
    (x) => (x.runs.get(1).event = "dynamic"),
  ]) {
    const fixture = checks();
    fixture.pullNumber = 490;
    for (const run of fixture.runs.values())
      run.pull_requests = [{ number: 490, head: { sha: head } }];
    for (const run of fixture.runs.values())
      if (run.path.startsWith("dynamic/"))
        Object.assign(run, {
          event: "dynamic",
          head_branch: "refs/pull/490/head",
          pull_requests: [],
        });
    mutate(fixture);
    assert.equal(evaluateCandidateChecks(fixture).ok, false);
  }
});

test("collector retains raw real dynamic runs while binding its candidate verdict to the requested PR", async () => {
  const { collectCandidateChecks } = await import("./pr-maintenance.mjs");
  const fixture = checks();
  for (const run of fixture.runs.values())
    if (run.path.startsWith("dynamic/"))
      Object.assign(run, {
        event: "dynamic",
        head_branch: "refs/pull/490/head",
        pull_requests: [],
      });
  const github = {
    rest: {
      checks: {
        listForRef: async () => ({
          data: {
            total_count: fixture.checkRuns.length,
            check_runs: fixture.checkRuns,
          },
        }),
      },
      actions: {
        getWorkflowRun: async ({ run_id }) => ({
          data: fixture.runs.get(run_id),
        }),
      },
    },
  };
  const good = await collectCandidateChecks({
    github,
    owner: "owner",
    repo: "repo",
    headSha: head,
    pullNumber: 490,
  });
  assert.equal(good.ci.ok, true);
  const wrong = await collectCandidateChecks({
    github,
    owner: "owner",
    repo: "repo",
    headSha: head,
    pullNumber: 491,
  });
  assert.equal(wrong.ci.ok, false);
  assert.equal(wrong.runs.get(5).event, "dynamic");
});

test("ordinary candidate workflows cannot borrow evidence from another PR at the same SHA", () => {
  const fixture = checks();
  fixture.pullNumber = 490;
  for (const run of fixture.runs.values())
    run.pull_requests = [{ number: 490, head: { sha: head } }];
  for (const run of fixture.runs.values()) {
    run.pull_requests = [{ number: 99, head: { sha: head } }];
    if (run.path.startsWith("dynamic/")) {
      run.event = "dynamic";
      run.head_branch = "refs/pull/490/head";
    }
  }
  assert.equal(evaluateCandidateChecks(fixture).ok, false);
});
