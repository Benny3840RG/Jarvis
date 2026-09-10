import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const build = fs.readFileSync(
  new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
  "utf8",
);
const worker = build.split("\n  build:")[1].split("\n  checkpoint:")[0];
test("candidate worker depends on durable admission but receives no durable or approval credentials", () => {
  assert.match(worker, /needs: mission/);
  assert.match(worker, /needs.mission.outputs.source-sha/);
  assert.doesNotMatch(
    worker,
    /secrets\.(?:JARVIS_SERVICE_TOKEN|JARVIS_APPROVAL_TOKEN|CONVEX_DEPLOY_KEY)/,
  );
  assert.match(build, /run-development-actions.mjs supervise/);
  assert.match(build, /cancelWorkflowRun/);
});
test("completion observer has no write/merge/approval path and checks out only trusted workflow code", () => {
  const source = fs.readFileSync(
    new URL("../workflows/jarvis-development-completion.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /:\s*write\b|pull_request_target|pulls\.merge/);
  assert.match(source, /github.workflow_sha/);
  assert.match(source, /cron:/);
  const entry = fs.readFileSync(
    new URL("./run-development-actions.mjs", import.meta.url),
    "utf8",
  );
  assert.match(entry, /completeExistingDevelopmentMission/);
  assert.doesNotMatch(
    entry,
    /toolActions:approve|mergePullRequest|nextState:\s*['"]complete/,
  );
});

test("checkpoint binds guarded build outputs on a trusted separate runner", () => {
  const checkpoint = build
    .split("\n  checkpoint:")[1]
    .split("\n  verify-candidate:")[0];
  assert.match(checkpoint, /needs: \[mission, build\]/);
  assert.match(checkpoint, /github.workflow_sha/);
  assert.match(checkpoint, /needs.build.outputs.candidate-sha/);
  assert.match(checkpoint, /needs.build.outputs.pr-url/);
  assert.match(checkpoint, /run-development-actions.mjs checkpoint/);
  const entry = fs.readFileSync(
    new URL("./run-development-actions.mjs", import.meta.url),
    "utf8",
  );
  const supervisor = entry
    .split("async function supervise()")[1]
    .split("async function complete()")[0];
  assert.doesNotMatch(supervisor, /missions.checkpoint|pull.head/);
});

// Issue approval must not populate a repository-wide default for later missions.
test("admission budget is selected only by the dispatched issue number", () => {
  const mission = build.split("\n  mission:")[1].split("\n  supervise:")[0];
  assert.ok(
    mission.includes(
      "vars[format('JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_{0}', inputs.issue_number)]",
    ),
  );
  assert.doesNotMatch(
    mission,
    /vars\.JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET\b|\|\|/,
  );
});
