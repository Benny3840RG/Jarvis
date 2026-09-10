import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const workflow = fs.readFileSync(
  new URL("../workflows/jarvis-pr-maintenance.yml", import.meta.url),
  "utf8",
);
const reviewJob = workflow.split("\n  review:")[1].split("\n  publish:")[0];
const publishJob = workflow.split("\n  publish:")[1];

test("run names containing issue hashes are folded YAML scalars, not comments", () => {
  for (const path of ["jarvis-pr-maintenance.yml", "jarvis-autobuild.yml"]) {
    const source = fs.readFileSync(
      new URL(`../workflows/${path}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /^run-name: >-\n  \$\{\{[^\n]+#.+\}\}$/m);
  }
});

test("reviewer never receives a write token or executes a candidate checkout", () => {
  assert.match(reviewJob, /permission-profile: ":read-only"/);
  assert.match(reviewJob, /safety-strategy: drop-sudo/);
  assert.doesNotMatch(reviewJob, /:\s*write\b/);
  assert.doesNotMatch(
    reviewJob,
    /ref:.*(?:expected_head|head\.sha|pull_request)/,
  );
  assert.doesNotMatch(
    reviewJob,
    /npm (?:ci|test|run)|GH_TOKEN|JARVIS_SERVICE_TOKEN/,
  );
  assert.match(reviewJob, /working-directory:.*runner.temp/);
  assert.match(reviewJob, /skip-git-repo-check/);
});

test("publication is isolated from model execution and rechecks provider evidence", () => {
  assert.match(publishJob, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(
    publishJob,
    /codex-action|contents: write|JARVIS_APPROVAL_TOKEN|OPENAI_API_KEY/,
  );
  assert.deepEqual(
    [...publishJob.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]),
    ["JARVIS_SERVICE_TOKEN"],
  );
  assert.match(publishJob, /publishReview/);
  assert.match(publishJob, /github.workflow_sha/);
  assert.doesNotMatch(
    workflow,
    /pull_request_target|pulls\.merge|createReview|markPullRequestReady|enablePullRequestAutoMerge/,
  );
});

test("every action is SHA pinned and every checkout drops credentials", () => {
  for (const match of workflow.matchAll(/^\s*uses: (\S+)/gm))
    assert.match(match[1], /@[a-f0-9]{40}$/);
  const checkouts = [...workflow.matchAll(/uses: actions\/checkout@/g)].length;
  assert.equal(
    [...workflow.matchAll(/persist-credentials: false/g)].length,
    checkouts,
  );
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
});

test("review context uses bounded chunks and a prompt file instead of one oversized action input", () => {
  assert.match(reviewJob, /prompt-file:/);
  assert.doesNotMatch(reviewJob, /prompt:|needs.prepare.outputs.prompt[ }]/);
  for (let i = 0; i < 6; i++)
    assert.ok(reviewJob.includes(`PROMPT_CHUNK_${i}:`));
  assert.match(reviewJob, /PROMPT_DIGEST:/);
  assert.match(publishJob, /pull-requests: write/);
});
