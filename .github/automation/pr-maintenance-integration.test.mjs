import assert from "node:assert/strict";
import { test } from "node:test";
import { collectCandidateChecks } from "./pr-maintenance.mjs";
import {
  prepareReview,
  publishReview,
  reviewRunTitle,
  sweep,
} from "./pr-maintenance-controller.mjs";
import {
  REQUIRED_WORKFLOW_CHECKS,
  EXPECTED_CODEQL_LANGUAGES,
} from "./revision-health.mjs";

function fixture() {
  const head = "a".repeat(40),
    base = "b".repeat(40);
  const writes = [],
    history = [];
  const pull = {
    number: 12,
    created_at: "2026-09-10T00:00:00Z",
    state: "open",
    title: "Improve notes",
    body: "Approved scope",
    changed_files: 1,
    labels: [],
    head: { sha: head, ref: "feature/notes", repo: { full_name: "o/r" } },
    base: { sha: base, ref: "main" },
  };
  const files = [
    {
      filename: "docs/notes.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
  ];
  const producers = [
    ...Object.entries(REQUIRED_WORKFLOW_CHECKS),
    ["pr-evidence", ".github/workflows/copilot-check.yml"],
    ...EXPECTED_CODEQL_LANGUAGES.map((l) => [
      `Analyze (${l})`,
      "dynamic/github-code-scanning/codeql",
    ]),
  ];
  const checkSets = new Map(),
    runs = new Map();
  for (const [target, offset] of [
    [head, 0],
    [base, 100],
  ]) {
    checkSets.set(
      target,
      producers.map(([name, path], i) => {
        const id = offset + i + 1;
        runs.set(id, {
          id,
          path,
          head_sha: target,
          event: path.startsWith("dynamic/")
            ? "dynamic"
            : target === head
              ? "pull_request"
              : "push",
          head_branch: target === head ? "refs/pull/12/head" : "main",
          pull_requests: [{ number: 12, head: { sha: target } }],
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
        });
        return {
          id,
          name,
          head_sha: target,
          app: { slug: "github-actions" },
          status: "completed",
          conclusion: "success",
          details_url: `https://github.com/o/r/actions/runs/${id}/job/1`,
        };
      }),
    );
  }
  const record = (kind) => async (args) => {
    writes.push({ kind, ...args });
    return { data: {} };
  };
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: pull }),
        list: async () => [pull],
        listFiles: async () => files,
      },
      repos: {
        getBranch: async () => ({ data: { commit: { sha: base } } }),
        getContent: async ({ ref }) => {
          const text = ref === base ? "old\n" : "new\n";
          return {
            data: {
              type: "file",
              encoding: "base64",
              size: Buffer.byteLength(text),
              content: Buffer.from(text).toString("base64"),
            },
          };
        },
        createCommitStatus: record("status"),
      },
      checks: {
        listForRef: async ({ ref }) => ({
          data: {
            total_count: checkSets.get(ref).length,
            check_runs: checkSets.get(ref),
          },
        }),
      },
      actions: {
        getWorkflowRun: async ({ run_id }) => ({ data: runs.get(run_id) }),
        listWorkflowRuns: async ({ workflow_id }) => ({
          data: {
            total_count:
              workflow_id === "jarvis-pr-maintenance.yml" ? history.length : 0,
            workflow_runs:
              workflow_id === "jarvis-pr-maintenance.yml" ? history : [],
          },
        }),
        createWorkflowDispatch: record("dispatch"),
      },
      issues: {
        get: async () => ({
          data: {
            number: 7,
            state: "open",
            labels: [{ name: "automation-approved" }],
          },
        }),
        createComment: record("comment"),
      },
    },
    paginate: async (method, args) => method(args),
  };
  const core = { info() {}, warning() {} };
  return {
    github,
    head,
    base,
    pull,
    files,
    writes,
    history,
    checkSets,
    runs,
    core,
    async identity() {
      const e = await collectCandidateChecks({
        github,
        owner: "o",
        repo: "r",
        headSha: head,
      });
      return {
        pullNumber: 12,
        headSha: head,
        baseSha: base,
        fingerprint: e.fingerprint,
      };
    },
    async publish(
      identity,
      rawReview = JSON.stringify({
        verdict: "pass",
        summary: "No defects found",
        findings: [],
      }),
      reviewResult = "success",
    ) {
      return publishReview({
        github,
        owner: "o",
        repo: "r",
        identity,
        rawReview,
        reviewResult,
        runId: 500,
        serverUrl: "https://github.com",
        recordDevelopment: async (input) => {
          writes.push({ kind: "development", ...input });
        },
      });
    },
  };
}

test("publication refuses stale candidate, base and check evidence before any write", async () => {
  for (const mutate of [
    (f) => {
      f.pull.head.sha = "c".repeat(40);
    },
    (f) => {
      f.pull.base.sha = "c".repeat(40);
    },
    (f) => {
      f.checkSets.get(f.head)[0].conclusion = "failure";
    },
  ]) {
    const f = fixture(),
      identity = await f.identity();
    mutate(f);
    await assert.rejects(() => f.publish(identity));
    assert.deepEqual(f.writes, []);
  }
});

test("failed, malformed and out-of-diff model evidence cannot dispatch a repair", async () => {
  for (const [raw, result] of [
    ["{}", "success"],
    ["not json", "success"],
    ["", "failure"],
    [
      JSON.stringify({
        verdict: "changes_requested",
        summary: "Change this",
        findings: [
          {
            file: "src/invented.ts",
            line: 1,
            severity: "high",
            message: "Invented task",
          },
        ],
      }),
      "success",
    ],
  ]) {
    const f = fixture();
    f.pull.head.ref = "automation/issue-7/run-1";
    f.pull.labels = ["automation-generated"];
    assert.equal(await f.publish(await f.identity(), raw, result), "blocked");
    assert.equal(
      f.writes.some((w) => w.kind === "dispatch"),
      false,
    );
    assert.equal(f.writes.find((w) => w.kind === "status").state, "failure");
    assert.equal(
      f.writes.find((w) => w.kind === "development")?.review.verdict,
      "blocked",
    );
  }
});

test("unhealthy main prevents repair dispatch even with actionable review", async () => {
  const f = fixture();
  f.pull.head.ref = "automation/issue-7/run-1";
  f.pull.labels = ["automation-generated"];
  f.checkSets.get(f.base)[0].conclusion = "failure";
  const review = JSON.stringify({
    verdict: "changes_requested",
    summary: "Correct notes",
    findings: [
      {
        file: "docs/notes.md",
        line: 1,
        severity: "medium",
        message: "Incorrect statement",
      },
    ],
  });
  const identity = await f.identity();
  await assert.rejects(
    () => f.publish(identity, review),
    /Main is not healthy/,
  );
  assert.equal(
    f.writes.some((w) => w.kind === "dispatch"),
    false,
  );
});

test("full sweep prepare publish cycle produces advisory owner gate and run-history dedupe", async () => {
  const f = fixture();
  const identity = await sweep({
    candidateReady: async () => true,
    github: f.github,
    owner: "o",
    repo: "r",
    core: f.core,
  });
  assert.equal(f.writes.filter((w) => w.kind === "dispatch").length, 1);
  const prompt = await prepareReview({
    github: f.github,
    owner: "o",
    repo: "r",
    identity,
    runId: 500,
    runAttempt: 1,
  });
  assert.match(prompt, /UNTRUSTED DATA/);
  assert.match(prompt, /old/);
  assert.match(prompt, /new/);
  assert.equal(await f.publish(identity), "awaiting-owner");
  assert.equal(f.writes.find((w) => w.kind === "status").state, "success");
  assert.equal(f.writes.filter((w) => w.kind === "dispatch").length, 1);
  f.history.push({
    id: 500,
    display_title: reviewRunTitle(identity),
    path: ".github/workflows/jarvis-pr-maintenance.yml",
    event: "workflow_dispatch",
    head_branch: "main",
  });
  assert.equal(
    await sweep({
      candidateReady: async () => true,
      github: f.github,
      owner: "o",
      repo: "r",
      core: f.core,
    }),
    null,
  );
  assert.equal(f.writes.filter((w) => w.kind === "dispatch").length, 1);
  // No mock approval/merge endpoint exists: invoking one fails this test.
});

test("durable scheduling defers mutable or foreign candidates before consuming review budget", async () => {
  const { durableCandidateReady } =
    await import("./pr-maintenance-controller.mjs");
  const pull = {
    number: 12,
    head: { ref: "automation/issue-7/run-1", sha: "a".repeat(40) },
  };
  let state = "BUILDING",
    number = 12,
    head = pull.head.sha;
  const call = async (_kind, name) =>
    name === "developmentState:get"
      ? { state }
      : [
          {
            transitionId: "DEV_TRANSITION_BUILDING_TO_VERIFYING",
            eventType: "DEV_TRANSITION_COMMITTED",
            payload: { effectPayload: { pullNumber: number, headSha: head } },
          },
        ];
  assert.equal(await durableCandidateReady(pull, "o/r", call), false);
  state = "VERIFYING";
  assert.equal(await durableCandidateReady(pull, "o/r", call), true);
  number = 99;
  assert.equal(await durableCandidateReady(pull, "o/r", call), false);
  number = 12;
  head = "b".repeat(40);
  assert.equal(await durableCandidateReady(pull, "o/r", call), false);
});

test("missing generated label does not silently disable durable review recording", async () => {
  const f = fixture();
  f.pull.head.ref = "automation/issue-7/run-1";
  await f.publish(await f.identity());
  assert.equal(f.writes.find((w) => w.kind === "development")?.issueNumber, 7);
});
for (const extra of [{ event: "pull_request" }, { head_branch: "foreign" }]) {
  test("same-SHA foreign branch or PR checks cannot authorise repair", async () => {
    const f = fixture();
    f.pull.head.ref = "automation/issue-7/run-1";
    f.pull.labels = ["automation-generated"];
    Object.assign(f.runs.get(101), extra);
    const raw = JSON.stringify({
      verdict: "changes_requested",
      summary: "Fix notes",
      findings: [
        {
          file: "docs/notes.md",
          line: 1,
          severity: "medium",
          message: "Wrong statement",
        },
      ],
    });
    await assert.rejects(
      f.publish(await f.identity(), raw),
      /Main is not healthy/,
    );
    assert.equal(
      f.writes.some((w) => w.kind === "dispatch"),
      false,
    );
  });
}
