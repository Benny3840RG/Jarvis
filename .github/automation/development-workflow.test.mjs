import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { evaluateDiff } from "./validate-autobuild.mjs";

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

test("admission keeps the issue override and falls back to owner-approved standing 0.05", () => {
  const mission = build.split("\n  mission:")[1].split("\n  supervise:")[0];
  assert.ok(
    mission.includes(
      "vars[format('JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_{0}', inputs.issue_number)]",
    ),
  );
  const entry = fs.readFileSync(
    new URL("./run-development-actions.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    entry,
    /env\.JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET\s*\|\|\s*["']0\.05["']/,
  );
});

test("bounded worker may repair ordinary reconciliation persistence integration and Convex implementation paths", () => {
  const files = [
    {
      path: "typescript/convex/externalReconciliations.ts",
      status: "M",
      additions: 8,
      deletions: 3,
    },
    {
      path: "typescript/convex/externalReconciliations.test.ts",
      status: "M",
      additions: 18,
      deletions: 1,
    },
    {
      path: "typescript/src/persistence/convexExternalReconciliations.ts",
      status: "M",
      additions: 7,
      deletions: 2,
    },
    {
      path: "typescript/src/reconciliation/reconciliationWorker.ts",
      status: "M",
      additions: 6,
      deletions: 2,
    },
    {
      path: "typescript/src/integrations/outlookAdapter.ts",
      status: "M",
      additions: 5,
      deletions: 2,
    },
    {
      path: "typescript/tests/convexExternalReconciliations.test.ts",
      status: "M",
      additions: 24,
      deletions: 0,
    },
    {
      path: "typescript/tests/reconciliationWorker.test.ts",
      status: "M",
      additions: 12,
      deletions: 0,
    },
    {
      path: "typescript/tests/outlookAdapter.test.ts",
      status: "M",
      additions: 12,
      deletions: 0,
    },
  ];

  assert.deepEqual(evaluateDiff({ files }), { ok: true, reasons: [] });
});

test("standing authority still denies automation dependency schema deployment and governance controls", () => {
  for (const path of [
    ".github/workflows/evil.yml",
    ".github/automation/validate-autobuild.mjs",
    ".env.local",
    "typescript/package.json",
    "typescript/package-lock.json",
    "typescript/convex/schema.ts",
    "convex.json",
    "typescript/src/deployment/production.ts",
    "docs/governance/README.md",
    "docs/deployment.md",
  ]) {
    const result = evaluateDiff({
      files: [{ path, status: "M", additions: 1, deletions: 0 }],
    });
    assert.equal(result.ok, false, path);
    assert.ok(
      result.reasons.some((reason) => reason.includes(path)),
      `expected forbidden-path reason for ${path}: ${result.reasons.join(", ")}`,
    );
  }
});

test("completed failed autonomous builds have bounded trusted recovery without owner reruns", async () => {
  const workflowUrl = new URL(
    "../workflows/jarvis-autobuild-recovery.yml",
    import.meta.url,
  );
  const helperUrl = new URL("./autobuild-recovery.mjs", import.meta.url);
  assert.equal(
    fs.existsSync(workflowUrl),
    true,
    "recovery workflow must exist",
  );
  assert.equal(
    fs.existsSync(helperUrl),
    true,
    "recovery policy helper must exist",
  );

  const workflow = fs.readFileSync(workflowUrl, "utf8");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /Jarvis autonomous build/);
  assert.match(workflow, /actions:\s*write/);
  assert.match(workflow, /issues:\s*write/);
  assert.match(workflow, /jarvis-queue-advance\.yml/);
  assert.match(workflow, /automation-blocked/);
  assert.match(workflow, /@claude/);
  assert.doesNotMatch(workflow, /pulls\.merge|deploy|commission/);

  const { classifyAutobuildRecovery, MAX_AUTOMATIC_RETRIES } = await import(
    helperUrl.href
  );
  assert.equal(MAX_AUTOMATIC_RETRIES, 2);

  const retryableReceipt = {
    build_result: "failure",
    verification_result: "skipped",
    stages: {
      dependencies: "success",
      worker: "failure",
      guard: "skipped",
      publication: "skipped",
    },
  };
  assert.equal(
    classifyAutobuildRecovery({ receipt: retryableReceipt, priorRetries: 0 })
      .action,
    "retry",
  );
  assert.equal(
    classifyAutobuildRecovery({ receipt: retryableReceipt, priorRetries: 2 })
      .action,
    "block",
  );

  const guardFailure = {
    ...retryableReceipt,
    stages: {
      ...retryableReceipt.stages,
      worker: "success",
      guard: "failure",
    },
  };
  assert.deepEqual(
    classifyAutobuildRecovery({ receipt: guardFailure, priorRetries: 0 }),
    { action: "block", reason: "policy-guard-failure" },
  );

  const publishedCandidate = {
    ...retryableReceipt,
    build_result: "success",
    verification_result: "failure",
    stages: {
      ...retryableReceipt.stages,
      worker: "success",
      guard: "success",
      publication: "success",
    },
  };
  assert.deepEqual(
    classifyAutobuildRecovery({ receipt: publishedCandidate, priorRetries: 0 }),
    { action: "ignore", reason: "candidate-published" },
  );
});
