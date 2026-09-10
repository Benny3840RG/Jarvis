import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reviewRunTitle,
  hasReviewAttempt,
  eligiblePull,
  listWorkflowHistory,
} from "./pr-maintenance-controller.mjs";

const identity = {
  pullNumber: 12,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  fingerprint: "c".repeat(64),
};
test("a review attempt is identified by provider run history, never by comment text", () => {
  const run = {
    display_title: reviewRunTitle(identity),
    path: ".github/workflows/jarvis-pr-maintenance.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    id: 1,
  };
  assert.equal(hasReviewAttempt([run], identity), true);
  for (const changed of [
    { ...run, path: "other.yml" },
    { ...run, event: "pull_request" },
    { ...run, head_branch: "other" },
  ]) {
    assert.equal(hasReviewAttempt([changed], identity), false);
  }
  assert.equal(
    hasReviewAttempt([run], { ...identity, headSha: "d".repeat(40) }),
    false,
  );
  assert.equal(
    hasReviewAttempt([run], { ...identity, fingerprint: "d".repeat(64) }),
    false,
  );
  // Cancellation also consumes an automatic attempt: sweeps cannot spend forever.
  assert.equal(
    hasReviewAttempt([{ ...run, conclusion: "cancelled" }], identity),
    true,
  );
});

test("review eligibility excludes forks, non-main targets and closed candidates", () => {
  const pull = {
    number: 12,
    state: "open",
    head: { repo: { full_name: "o/r" }, sha: identity.headSha },
    base: { ref: "main", sha: identity.baseSha },
  };
  assert.equal(eligiblePull(pull, "o/r"), true);
  assert.equal(eligiblePull({ ...pull, state: "closed" }, "o/r"), false);
  assert.equal(eligiblePull(pull, "foreign/repo"), false);
  assert.equal(
    eligiblePull({ ...pull, base: { ...pull.base, ref: "other" } }, "o/r"),
    false,
  );
});

test("run history must be complete, unique and bounded", async () => {
  const github = {
    rest: {
      actions: {
        listWorkflowRuns: async () => ({
          data: { total_count: 1, workflow_runs: [{ id: 1 }] },
        }),
      },
    },
  };
  assert.equal((await listWorkflowHistory(github, "o", "r")).length, 1);
  github.rest.actions.listWorkflowRuns = async () => ({
    data: { total_count: 2, workflow_runs: [{ id: 1 }] },
  });
  await assert.rejects(() => listWorkflowHistory(github, "o", "r"));
  github.rest.actions.listWorkflowRuns = async () => ({
    data: { total_count: 1001, workflow_runs: [] },
  });
  await assert.rejects(() => listWorkflowHistory(github, "o", "r"));
});
