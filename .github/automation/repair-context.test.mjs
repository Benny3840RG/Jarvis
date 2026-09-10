import assert from "node:assert/strict";
import { test } from "node:test";
import { collectRepairContext } from "./pr-repair.mjs";
test("repair context retains the exact triggering review and valid JSON despite older comments", async () => {
  const head = "a".repeat(40),
    base = "b".repeat(40),
    fingerprint = "c".repeat(64);
  const input = {
    owner: "o",
    repo: "r",
    pullNumber: 12,
    headSha: head,
    reviewRunId: 42,
    reviewCommentId: 7,
  };
  const comment = {
    id: 7,
    user: { login: "github-actions[bot]" },
    issue_url: "https://api.github.com/repos/o/r/issues/12",
    body: `<!-- jarvis-pr-maintenance:v1 -->\nCandidate: \`${head}\`\n[Evidence run](https://github.com/o/r/actions/runs/42)\nFix the actual failing boundary`,
  };
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({
          data: {
            id: 42,
            path: ".github/workflows/jarvis-pr-maintenance.yml",
            head_branch: "main",
            event: "workflow_dispatch",
            display_title: `Jarvis PR review #12 ${head} ${base} ${fingerprint}`,
          },
        }),
      },
      issues: { getComment: async () => ({ data: comment }) },
      checks: {
        listForRef: async () => ({
          data: {
            total_count: 1,
            check_runs: [
              {
                name: "tests",
                conclusion: "failure",
                output: { summary: "x".repeat(9000) },
              },
            ],
          },
        }),
      },
    },
  };
  const result = JSON.parse(await collectRepairContext({ ...input, github }));
  assert.match(result.review, /actual failing boundary/);
  assert.equal(result.checks[0].conclusion, "failure");
  comment.body = "Unbound older comment";
  await assert.rejects(() => collectRepairContext({ ...input, github }));
});
