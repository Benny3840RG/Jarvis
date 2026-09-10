import test from "node:test";
import assert from "node:assert/strict";
import {
  observeUnpublishedWorker,
  checkpointPublishedWorker,
} from "./development-worker-recovery.mjs";
const repository = "o/r",
  issueNumber = 7,
  runId = 1;
const run = {
  id: 1,
  run_attempt: 1,
  path: ".github/workflows/jarvis-autobuild.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_repository: { full_name: repository },
  status: "completed",
  display_title: "Jarvis build issue #7",
};
test("recovery observes completed owning initial run and absence of both branch and PR", async () => {
  for (const defect of [
    "none",
    "active",
    "foreign",
    "repair",
    "rerun",
    "branch",
    "pr",
    "unavailable",
  ]) {
    const get = async (path) => {
      if (defect === "unavailable") throw new Error("unavailable");
      if (path.startsWith("actions/"))
        return {
          ...run,
          ...(defect === "active" ? { status: "in_progress" } : {}),
          ...(defect === "foreign"
            ? { display_title: "Jarvis build issue #8" }
            : {}),
          ...(defect === "repair"
            ? { display_title: "Jarvis repair PR #12" }
            : {}),
          ...(defect === "rerun" ? { run_attempt: 2 } : {}),
        };
      if (path.startsWith("pulls?"))
        return defect === "pr" ? [{ number: 12 }] : [];
      return defect === "branch" ? { ref: "exists" } : null;
    };
    const action = observeUnpublishedWorker({
      get,
      repository,
      issueNumber,
      workerId: "github-actions:1",
    });
    if (defect === "none") await action;
    else await assert.rejects(action);
  }
});
test("publication mismatch and observation failure persist failed checkpoint with no candidate binding", async () => {
  for (const unavailable of [false, true]) {
    const calls = [];
    await assert.rejects(
      checkpointPublishedWorker({
        repository,
        issueNumber,
        runId,
        env: {
          CANDIDATE_SHA: "a".repeat(40),
          PR_URL: "https://github.com/o/r/pull/12",
          BUILD_RESULT: "success",
        },
        get: async () => {
          if (unavailable) throw new Error("unavailable");
          return { number: 99 };
        },
        missions: { checkpoint: async (input) => calls.push(input) },
      }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].success, false);
    assert.equal(calls[0].pullNumber, 0);
    assert.equal(calls[0].headSha, "");
  }
});
