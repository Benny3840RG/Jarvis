import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateDiff,
  evaluateIndexFlags,
  evaluateIssue,
  evaluatePatch,
  redactReceipt,
  validateCiContract,
  validatePromptContract,
  validateQueueAdvanceContract,
  validateWorkflowContract,
} from "./validate-autobuild.mjs";

const eligibleIssue = {
  state: "open",
  labels: ["automation-approved"],
  body: "## Acceptance criteria\n\n- [ ] Add the requested behaviour\n- [ ] Cover it with tests",
  hasExistingAutomationPr: false,
};

test("comment-only Claude action uses the scoped workflow token without OIDC exchange", () => {
  const workflow = fs.readFileSync(
    new URL("../workflows/claude.yml", import.meta.url),
    "utf8",
  );
  // The pinned action otherwise exchanges OIDC for a separately scoped app token.
  assert.match(workflow, /github_token: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /^\s+id-token:\s+write/m);
  assert.doesNotMatch(workflow, /^\s+contents:\s+write/m);
  assert.match(workflow, /^\s+contents:\s+read/m);
  const issueTypes = workflow.match(/^  issues:\n    types: \[([^\]]+)\]$/m);
  assert.ok(issueTypes, "issues must declare an explicit bounded trigger list");
  assert.deepEqual(
    issueTypes[1].split(",").map((value) => value.trim()),
    ["opened", "edited"],
  );
});

async function runFinalize(overrides = {}) {
  const workflow = fs.readFileSync(
    new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
    "utf8",
  );
  const finalizerStart = workflow.indexOf("\n  finalize:");
  assert.notEqual(finalizerStart, -1, "workflow must contain the finalize job");
  const finalizer = workflow.slice(finalizerStart);
  const scriptBody = finalizer.split("          script: |\n")[1];
  assert.ok(
    scriptBody?.trim(),
    "finalize job must contain a github-script body",
  );
  const script = scriptBody
    .split("\n")
    .map((line) => line.slice(12))
    .join("\n");
  const comments = [];
  const statuses = [];
  const labels = [];
  const removedLabels = [];
  const failures = [];
  const env = {
    ISSUE_NUMBER: "435",
    BUILD_RESULT: "failure",
    VERIFY_RESULT: "skipped",
    LOCK_ACQUIRED: "true",
    SOURCE_SHA: "a".repeat(40),
    CODEX_OUTCOME: "failure",
    DEPENDENCIES_OUTCOME: "success",
    GUARD_OUTCOME: "skipped",
    PUBLISH_OUTCOME: "skipped",
    ...overrides,
  };
  const github = {
    paginate: async () => [],
    rest: {
      repos: { createCommitStatus: async (value) => statuses.push(value) },
      issues: {
        listComments: async () => {},
        createComment: async (value) => comments.push(value.body),
        addLabels: async (value) => labels.push(value.labels),
        removeLabel: async (value) => removedLabels.push(value.name),
      },
    },
  };
  const context = {
    repo: { owner: "owner", repo: "repo" },
    runId: 123,
    serverUrl: "https://github.com",
  };
  await new Function(
    "context",
    "github",
    "core",
    "process",
    `return (async () => {${script}\n})();`,
  )(
    context,
    github,
    { info: () => {}, setFailed: (m) => failures.push(String(m)) },
    { env },
  );
  const body = comments.join("\n");
  return { body, comments, statuses, labels, removedLabels, failures };
}

async function finalizeRun(overrides = {}) {
  const result = await runFinalize(overrides);
  const match = result.body.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(
    match,
    "finalization must persist its diagnostic receipt in the issue",
  );
  assert.deepEqual(result.failures, [], "finalization must not fail the job");
  return { ...result, receipt: JSON.parse(match[1]) };
}

test("worker failure retains stage evidence without publishing success", async () => {
  const result = await finalizeRun();
  assert.equal(result.receipt.source_sha, "a".repeat(40));
  assert.equal(result.receipt.stages.worker, "failure");
  assert.equal(result.receipt.stages.guard, "skipped");
  assert.equal(result.receipt.build_result, "failure");
  assert.deepEqual(result.statuses, []);
  assert.deepEqual(result.labels, [["automation-blocked"]]);
});

test("cancelled jobs retain unavailable stages without inventing a worker result", async () => {
  const { receipt } = await finalizeRun({
    BUILD_RESULT: "cancelled",
    SOURCE_SHA: "",
    CODEX_OUTCOME: "",
  });
  assert.equal(receipt.source_sha, null);
  assert.equal(receipt.stages.worker, "unavailable");
  assert.equal(receipt.build_result, "cancelled");
});

test("receipt discards unexpected strings and never upgrades failed verification", async () => {
  const secret = "private-canary-do-not-persist";
  const result = await finalizeRun({
    BUILD_RESULT: "success",
    VERIFY_RESULT: "failure",
    CANDIDATE_SHA: "b".repeat(40),
    SOURCE_SHA: secret,
    CODEX_OUTCOME: secret,
    RAW_MODEL_OUTPUT: secret,
  });
  assert.equal(result.receipt.source_sha, null);
  assert.equal(result.receipt.stages.worker, "unavailable");
  assert.ok(!result.body.includes(secret));
  assert.equal(result.statuses[0].state, "failure");
  assert.deepEqual(result.labels, [["automation-blocked"]]);
});

test("a run that never acquired the lock leaves the issue for the queue to retry", async () => {
  const result = await runFinalize({
    LOCK_ACQUIRED: "",
    BUILD_RESULT: "failure",
    VERIFY_RESULT: "skipped",
  });
  assert.deepEqual(
    result.labels,
    [],
    "a race loser must not be marked automation-blocked",
  );
  assert.deepEqual(result.removedLabels, []);
  assert.deepEqual(result.comments, []);
  assert.deepEqual(result.failures, []);
});

test("dependency and worker timeouts reserve cleanup time and fail closed", () => {
  const workflow = fs.readFileSync(
    new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
    "utf8",
  );
  const build = workflow
    .split("\n  build:")[1]
    .split("\n  verify-candidate:")[0];
  const worker = build
    .split("- name: Run bounded Codex implementation")[1]
    .split("\n      - name:")[0];
  const dependencies = build
    .split("- name: Install locked dependencies before sandboxing")[1]
    .split("\n      - name:")[0];
  const jobLimit = Number(build.match(/timeout-minutes: (\d+)/)?.[1]);
  const workerLimit = Number(worker.match(/timeout-minutes: (\d+)/)?.[1]);
  const dependencyLimit = Number(
    dependencies.match(/timeout-minutes: (\d+)/)?.[1],
  );
  assert.equal(dependencyLimit, 5);
  assert.ok(workerLimit > 0 && workerLimit <= jobLimit - 10);
  assert.ok(dependencyLimit + workerLimit <= jobLimit - 10);
  assert.doesNotMatch(worker, /continue-on-error:\s*true/);
  assert.doesNotMatch(dependencies, /continue-on-error:\s*true/);
});

test("accepts a single approved open issue with acceptance criteria", () => {
  assert.deepEqual(evaluateIssue(eligibleIssue), { ok: true, reasons: [] });
});

test("rejects closed, unapproved, locked, duplicate, or underspecified issues", () => {
  const cases = [
    [{ ...eligibleIssue, state: "closed" }, "issue is not open"],
    [{ ...eligibleIssue, labels: [] }, "automation-approved label is missing"],
    [
      {
        ...eligibleIssue,
        labels: ["automation-approved", "automation-in-progress"],
      },
      "automation-in-progress lock is already present",
    ],
    [
      { ...eligibleIssue, hasExistingAutomationPr: true },
      "automation pull request already exists",
    ],
    [
      { ...eligibleIssue, body: "Please fix it." },
      "testable acceptance criteria are missing",
    ],
  ];

  for (const [input, reason] of cases) {
    const result = evaluateIssue(input);
    assert.equal(result.ok, false);
    assert.ok(
      result.reasons.includes(reason),
      `${reason}: ${result.reasons.join(", ")}`,
    );
  }
});

test("accepts bounded source and test changes", () => {
  const result = evaluateDiff({
    files: [
      {
        path: "typescript/src/example.ts",
        status: "M",
        additions: 10,
        deletions: 2,
      },
      {
        path: "typescript/tests/example.test.ts",
        status: "A",
        additions: 24,
        deletions: 0,
      },
    ],
  });

  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("requires a test change when source changes", () => {
  const result = evaluateDiff({
    files: [
      {
        path: "typescript/src/example.ts",
        status: "M",
        additions: 10,
        deletions: 2,
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.includes(
      "source changes require a matching node test change",
    ),
  );
});

test("rejects forbidden control, dependency, schema, deployment, binary, and symlink changes", () => {
  const forbidden = [
    ".github/workflows/evil.yml",
    ".github/automation/validate-autobuild.mjs",
    ".gitattributes",
    ".gitmodules",
    ".env.local",
    "typescript/package.json",
    "typescript/package-lock.json",
    "typescript/convex/schema.ts",
    "convex.json",
    "typescript/src/http/authentication.ts",
    "typescript/src/agent/actionPolicy.ts",
    "typescript/src/integrations/outlookAdapter.ts",
    "typescript/convex/externalReconciliation.ts",
    "typescript/src/deployment/production.ts",
    "typescript/src/actions/createNoteTool.ts",
    "typescript/src/http/serviceTokenGuard.ts",
    "typescript/src/http/toolActionController.ts",
    "typescript/src/runtime/totalityPolicy.ts",
    "typescript/src/runtime/validation.ts",
    "typescript/src/persistence/convexToolActions.ts",
    "typescript/src/http/jarvisHttpModule.ts",
    "typescript/src/orchestration/contracts.ts",
    "typescript/src/reconciliation/externalReconciliation.ts",
    "typescript/src/totality/totalityPipeline.ts",
    "typescript/src/persistence/convexQuoteDeliveries.ts",
    "typescript/convex/toolActionLogic.ts",
    "docs/governance/README.md",
    "docs/traceability/action-family-registry.yaml",
    "docs/deployment.md",
  ];

  for (const path of forbidden) {
    const result = evaluateDiff({
      files: [{ path, status: "M", additions: 1, deletions: 0 }],
    });
    assert.equal(result.ok, false, path);
    assert.ok(
      result.reasons.some((reason) => reason.includes(path)),
      path,
    );
  }

  for (const file of [
    {
      path: "typescript/src/link.ts",
      status: "A",
      additions: 1,
      deletions: 0,
      symlink: true,
    },
    {
      path: "typescript/src/blob.bin",
      status: "A",
      additions: 1,
      deletions: 0,
      binary: true,
    },
  ]) {
    assert.equal(evaluateDiff({ files: [file] }).ok, false, file.path);
  }
});

test("requires tests in each affected source area", () => {
  const result = evaluateDiff({
    files: [
      {
        path: "typescript/convex/example.ts",
        status: "M",
        additions: 5,
        deletions: 1,
      },
      {
        path: "typescript/tests/example.test.ts",
        status: "M",
        additions: 5,
        deletions: 1,
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.includes(
      "source changes require a matching convex test change",
    ),
  );
});

test("rejects assume-unchanged and skip-worktree index flags", () => {
  const result = evaluateIndexFlags([
    { tag: "h", path: ".github/automation/validate-autobuild.mjs" },
    { tag: "S", path: "typescript/package.json" },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 2);
});

test("detects the reproduced assume-unchanged validator bypass", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jarvis-index-guard-"),
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trimEnd();
  try {
    git("init", "--quiet");
    git("config", "user.name", "Jarvis Test");
    git("config", "user.email", "jarvis@example.invalid");
    fs.mkdirSync(path.join(directory, ".github", "automation"), {
      recursive: true,
    });
    const validatorPath = ".github/automation/validate-autobuild.mjs";
    fs.writeFileSync(
      path.join(directory, validatorPath),
      "export const safe = true;\n",
    );
    git("add", validatorPath);
    git("commit", "--quiet", "-m", "fixture");
    git("update-index", "--assume-unchanged", validatorPath);
    fs.writeFileSync(
      path.join(directory, validatorPath),
      "export const safe = false;\n",
    );

    assert.equal(git("diff", "--quiet", "HEAD", "--", validatorPath), "");
    const entries = git("ls-files", "-v", "-z")
      .split("\0")
      .filter(Boolean)
      .map((line) => ({ tag: line.slice(0, 1), path: line.slice(2) }));
    const result = evaluateIndexFlags(entries);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes(validatorPath)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects authority, credential, commissioning, and payment changes by content", () => {
  const result = evaluatePatch(
    [
      "diff --git a/typescript/src/http/main.ts b/typescript/src/http/main.ts",
      "@@ -1,0 +2,4 @@",
      "+const authorization = request.headers.authorization;",
      "+const requireApproval = false;",
      "+await commissionProduction();",
      "+await chargePayment();",
    ].join("\n"),
  );

  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((reason) => reason.includes("authority-sensitive")),
  );
});

test("allows authority-boundary prose in operational Markdown", () => {
  const result = evaluatePatch(
    [
      "diff --git a/docs/operations/autonomous-builds.md b/docs/operations/autonomous-builds.md",
      "--- a/docs/operations/autonomous-builds.md",
      "+++ b/docs/operations/autonomous-builds.md",
      "@@ -2,0 +3,1 @@",
      "+Owner review and merge remain mandatory; commissioning and deployment are never automatic.",
    ].join("\n"),
  );

  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("allows removal of authority prose from operational Markdown", () => {
  const result = evaluatePatch(
    [
      "diff --git a/docs/operations/runbook.md b/docs/operations/runbook.md",
      "--- a/docs/operations/runbook.md",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-Deployment requires owner approval.",
    ].join("\n"),
  );

  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("allows authority-model prose in Markdown outside docs/operations", () => {
  const result = evaluatePatch(
    [
      "diff --git a/docs/superpowers/plans/2026-09-01-phase1-ledger.md b/docs/superpowers/plans/2026-09-01-phase1-ledger.md",
      "--- a/docs/superpowers/plans/2026-09-01-phase1-ledger.md",
      "+++ b/docs/superpowers/plans/2026-09-01-phase1-ledger.md",
      "@@ -10,0 +11,2 @@",
      "+PR #470 introduced the serial queue coordinator: verify, select and",
      "+dispatch only — it does not review, approve, merge, commission or deploy.",
    ].join("\n"),
  );

  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("still scans a rename from an executable path into docs/", () => {
  const result = evaluatePatch(
    [
      "diff --git a/typescript/tests/authority.test.ts b/docs/superpowers/authority.md",
      "similarity index 60%",
      "rename from typescript/tests/authority.test.ts",
      "rename to docs/superpowers/authority.md",
      "--- a/typescript/tests/authority.test.ts",
      "+++ b/docs/superpowers/authority.md",
      "@@ -1,1 +1,1 @@",
      "-const requireApproval = false;",
      "+Owner approval remains mandatory.",
    ].join("\n"),
  );

  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((reason) => reason.includes("authority-sensitive")),
  );
});

test("does not exempt non-Markdown files under docs/", () => {
  const result = evaluatePatch(
    [
      "diff --git a/docs/scripts/deploy.sh b/docs/scripts/deploy.sh",
      "--- a/docs/scripts/deploy.sh",
      "+++ b/docs/scripts/deploy.sh",
      "@@ -1,0 +2,1 @@",
      "+export DEPLOYMENT_TOKEN=$(cat secret)",
    ].join("\n"),
  );

  assert.equal(result.ok, false);
});

test("does not exempt case-variant operational paths", () => {
  const result = evaluatePatch(
    [
      "diff --git a/docs/Operations/runbook.MD b/docs/Operations/runbook.MD",
      "--- a/docs/Operations/runbook.MD",
      "+++ b/docs/Operations/runbook.MD",
      "@@ -1,0 +2,1 @@",
      "+Deployment requires owner approval.",
    ].join("\n"),
  );

  assert.equal(result.ok, false);
});

test("scans executable removals when a file is renamed into operational docs", () => {
  const result = evaluatePatch(
    [
      "diff --git a/typescript/tests/authority.test.ts b/docs/operations/authority.md",
      "similarity index 60%",
      "rename from typescript/tests/authority.test.ts",
      "rename to docs/operations/authority.md",
      "--- a/typescript/tests/authority.test.ts",
      "+++ b/docs/operations/authority.md",
      "@@ -1,1 +1,1 @@",
      "-const requireApproval = false;",
      "+Owner approval remains mandatory.",
    ].join("\n"),
  );

  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((reason) => reason.includes("authority-sensitive")),
  );
});

test("does not treat header-shaped hunk content as path metadata", () => {
  const patches = [
    [
      "diff --git a/typescript/src/example.ts b/typescript/src/example.ts",
      "--- a/typescript/src/example.ts",
      "+++ b/typescript/src/example.ts",
      "@@ -1,0 +1,2 @@",
      "+++ b/docs/operations/spoof.md",
      "+const requireApproval = false;",
    ],
    [
      "diff --git a/typescript/src/example.ts b/typescript/src/example.ts",
      "--- a/typescript/src/example.ts",
      "+++ b/typescript/src/example.ts",
      "@@ -1,2 +1,0 @@",
      "--- a/docs/operations/spoof.md",
      "-const requireApproval = false;",
    ],
  ];

  for (const patch of patches) {
    assert.equal(evaluatePatch(patch.join("\n")).ok, false);
  }
});

test("allows ordinary implementation patches", () => {
  assert.deepEqual(
    evaluatePatch(
      [
        "diff --git a/typescript/src/tasks.ts b/typescript/src/tasks.ts",
        "@@ -1,0 +2,2 @@",
        "+const taskTitle = input.title.trim();",
        "+return { ...task, title: taskTitle };",
      ].join("\n"),
    ),
    { ok: true, reasons: [] },
  );
});

test("rejects authority-sensitive content in a newly added file", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jarvis-untracked-guard-"),
  );
  try {
    const newPath = path.join(directory, "harmless-name.ts");
    fs.writeFileSync(
      newPath,
      "export const allowed = requireApprovalBeforeExecution;\n",
    );
    const added = fs
      .readFileSync(newPath, "utf8")
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n");
    const patch = `diff --git a/harmless-name.ts b/harmless-name.ts\n+++ b/harmless-name.ts\n${added}`;
    assert.equal(evaluatePatch(patch).ok, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects empty and excessive diffs", () => {
  assert.equal(evaluateDiff({ files: [] }).ok, false);

  const tooManyFiles = Array.from({ length: 31 }, (_, index) => ({
    path: `docs/generated-${index}.md`,
    status: "A",
    additions: 1,
    deletions: 0,
  }));
  assert.ok(
    evaluateDiff({ files: tooManyFiles }).reasons.includes(
      "changed file limit exceeded",
    ),
  );

  assert.ok(
    evaluateDiff({
      files: [
        { path: "docs/large.md", status: "M", additions: 2_001, deletions: 0 },
      ],
    }).reasons.includes("diff line limit exceeded"),
  );
  assert.ok(
    evaluateDiff({
      files: [
        {
          path: "docs/large.md",
          status: "M",
          additions: 1,
          deletions: 0,
          bytes: 524_289,
        },
      ],
    }).reasons.includes("changed file byte limit exceeded: docs/large.md"),
  );
  assert.ok(
    evaluateDiff({
      files: [
        {
          path: "docs/a.md",
          status: "M",
          additions: 1,
          deletions: 0,
          bytes: 1_100_000,
        },
        {
          path: "docs/b.md",
          status: "M",
          additions: 1,
          deletions: 0,
          bytes: 1_100_000,
        },
      ],
    }).reasons.includes("total changed byte limit exceeded"),
  );
});

test("redacts credentials from receipts", () => {
  const receipt = redactReceipt(
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnop Authorization: Bearer abc.def-123 " +
      "JARVIS_SERVICE_TOKEN=secret-value CONVEX_DEPLOY_KEY=convex-secret",
  );

  assert.equal(receipt.includes("sk-proj-"), false);
  assert.equal(receipt.includes("abc.def-123"), false);
  assert.equal(receipt.includes("secret-value"), false);
  assert.equal(receipt.includes("convex-secret"), false);
  assert.match(receipt, /\[REDACTED/);
});

test("prompt contract captures the hard authority boundary", () => {
  const prompt = fs.readFileSync(
    new URL("./codex-autobuild-prompt.md", import.meta.url),
    "utf8",
  );

  assert.deepEqual(validatePromptContract(prompt), { ok: true, reasons: [] });
});

test("workflow contract requires safe triggers, isolation, draft output, and cleanup", () => {
  const workflow = fs.readFileSync(
    new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
    "utf8",
  );

  assert.deepEqual(validateWorkflowContract(workflow), {
    ok: true,
    reasons: [],
  });
  assert.match(workflow, /command -v node/);
  assert.match(
    workflow,
    /install -o root -g root -m 0555[\s\\]*"\$trusted_node"[\s\\]*\/opt\/jarvis-autobuild\/node/,
  );
  assert.match(workflow, /root:root:555/);
  assert.match(workflow, /\/opt\/jarvis-autobuild\/node --input-type=module/);
  assert.match(workflow, /jarvis-autobuild-lock:/);
  assert.match(workflow, /github\.paginate/);
  assert.match(workflow, /comment\.user\?\.login === "github-actions\[bot\]"/);

  const unavailableDefaultModel = workflow.replace(
    "model: gpt-5.6-luna",
    "model: gpt-6-astra",
  );
  assert.equal(validateWorkflowContract(unavailableDefaultModel).ok, false);
  assert.match(
    validateWorkflowContract(unavailableDefaultModel).reasons.join("\n"),
    /commissioned gpt-5\.6-luna model/i,
  );

  const overProvisionedDefaultModel = workflow.replace(
    "model: gpt-5.6-luna",
    "model: gpt-5.6-terra",
  );
  assert.equal(validateWorkflowContract(overProvisionedDefaultModel).ok, false);
  assert.match(
    validateWorkflowContract(overProvisionedDefaultModel).reasons.join("\n"),
    /commissioned gpt-5\.6-luna model/i,
  );

  const unboundedDefaultEffort = workflow.replace(
    "effort: medium",
    "effort: high",
  );
  assert.equal(validateWorkflowContract(unboundedDefaultEffort).ok, false);
  assert.match(
    validateWorkflowContract(unboundedDefaultEffort).reasons.join("\n"),
    /bounded medium reasoning effort/i,
  );
  assert.match(
    workflow,
    /name: Release the mission lock when no candidate was published[\s\S]*if: always\(\) && steps\.eligibility\.outputs\.lock_acquired == 'true' && steps\.publish\.outcome != 'success'/,
  );
  assert.equal(
    validateWorkflowContract(
      workflow.replace(
        'context: "jarvis-autobuild/verify-candidate"',
        'context: "pr-evidence"',
      ),
    ).ok,
    false,
  );
  assert.equal(
    validateWorkflowContract(
      workflow.replaceAll("jarvis-autobuild-lock:", "jarvis-lock-missing:"),
    ).ok,
    false,
  );
  const unrelatedFinalize = workflow.replace(
    /\n    if: always\(\) && github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\n/,
    "\n    if: always()\n",
  );
  assert.equal(
    validateWorkflowContract(unrelatedFinalize).ok,
    false,
    "finalize must stay scoped to a manual dispatch",
  );

  const successReleasesLock = workflow.replace(
    /Mission lock held/,
    "Mission lock released",
  );
  assert.equal(
    validateWorkflowContract(successReleasesLock).ok,
    false,
    "a successful build must keep the mission lock for its draft PR",
  );

  const fatalMetadataLabel = workflow.replace(
    /if ! gh pr edit "\$pr_url" --add-label automation-generated; then[\s\S]*?^          fi$/m,
    'gh pr edit "$pr_url" --add-label automation-generated',
  );
  assert.equal(
    validateWorkflowContract(fatalMetadataLabel).ok,
    false,
    "metadata labelling must never fail an otherwise valid publication",
  );

  const outputsAfterMetadata = workflow.replace(
    /(candidate_sha="[\s\S]*?echo "pr_url=\$pr_url" >>"\$GITHUB_OUTPUT"\n)([\s\S]*?if ! gh pr edit "\$pr_url" --add-label automation-generated; then[\s\S]*?^          fi$)/m,
    "$2\n$1",
  );
  assert.equal(
    validateWorkflowContract(outputsAfterMetadata).ok,
    false,
    "candidate outputs must be durable before optional metadata operations",
  );
});

const verificationSha = "a".repeat(40);
const verificationNames = [
  "automation-policy",
  "typecheck-lint-format-test",
  "jarvis-console-01-build",
  "pr-evidence",
  "Analyze (actions)",
  "Analyze (python)",
  "Analyze (ruby)",
  "Analyze (javascript-typescript)",
];
function verificationSuccess() {
  return verificationNames.map((name, index) => ({
    id: index + 1,
    name,
    head_sha: verificationSha,
    app: { slug: "github-actions" },
    details_url: `https://github.com/owner/repo/actions/runs/${index + 101}/job/1`,
    status: "completed",
    conclusion: "success",
  }));
}
function verificationRun(id) {
  const index = id - 101;
  return {
    id,
    head_sha: verificationSha,
    event: index < 4 ? "pull_request" : "dynamic",
    head_branch: index < 4 ? "candidate" : "refs/pull/12/head",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    path:
      index < 3
        ? ".github/workflows/typescript.yml"
        : index === 3
          ? ".github/workflows/copilot-check.yml"
          : "dynamic/github-code-scanning/codeql",
    head_repository: { full_name: "owner/repo" },
    pull_requests: [{ number: 12, head: { sha: verificationSha } }],
  };
}
async function runCandidateVerification({
  runs = [],
  checksByPoll = [verificationSuccess()],
  approveError,
  producerOverrides = {},
  pullHead = verificationSha,
} = {}) {
  const workflow = fs.readFileSync(
    new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
    "utf8",
  );
  const body = workflow
    .slice(
      workflow.indexOf("\n  verify-candidate:"),
      workflow.indexOf("\n  finalize:"),
    )
    .split("          script: |\n")[1];
  const script = body
    .split("\n")
    .map((line) => line.slice(12))
    .join("\n");
  const approved = [],
    failures = [],
    messages = [];
  let checkPoll = 0,
    now = 0;
  const github = {
    rest: {
      actions: {
        listWorkflowRunsForRepo: () => {},
        getWorkflowRun: async ({ run_id }) => ({
          data: { ...verificationRun(run_id), ...producerOverrides[run_id] },
        }),
        approveWorkflowRun: async ({ run_id }) => {
          if (approveError) throw approveError;
          approved.push(run_id);
        },
      },
      checks: {
        listForRef: async ({ ref }) => {
          assert.equal(ref, verificationSha);
          const check_runs =
            checksByPoll[Math.min(checkPoll++, checksByPoll.length - 1)];
          return { data: { total_count: check_runs.length, check_runs } };
        },
      },
      pulls: {
        get: async () => ({
          data: {
            number: 12,
            state: "open",
            base: { ref: "main" },
            head: { sha: pullHead, repo: { full_name: "owner/repo" } },
          },
        }),
      },
    },
    paginate: async (method, args) => {
      assert.equal(method, github.rest.actions.listWorkflowRunsForRepo);
      assert.equal(args.head_sha, verificationSha);
      assert.equal(args.event, undefined);
      return runs;
    },
  };
  await new Function(
    "github",
    "context",
    "core",
    "process",
    "Date",
    "setTimeout",
    "require",
    `return (async()=>{${script}\n})();`,
  )(
    github,
    { repo: { owner: "owner", repo: "repo" } },
    { setFailed: (m) => failures.push(m), info: (m) => messages.push(m) },
    {
      env: {
        CANDIDATE_SHA: verificationSha,
        PR_URL: "https://github.com/owner/repo/pull/12",
        GITHUB_WORKSPACE: path.resolve(
          new URL("../..", import.meta.url).pathname,
        ),
      },
    },
    { now: () => now },
    (cb, delay) => {
      now += delay;
      cb();
    },
    createRequire(import.meta.url),
  );
  return { approved, failures, messages, checkPoll };
}
test("candidate verifier approves only held known producers bound to the exact PR and head", async () => {
  const held = {
    ...verificationRun(101),
    id: 1,
    status: "completed",
    conclusion: "action_required",
  };
  const result = await runCandidateVerification({
    runs: [
      held,
      { ...held, id: 2, path: ".github/workflows/untrusted.yml" },
      { ...held, id: 3, head_sha: "b".repeat(40) },
      { ...held, id: 4, event: "push" },
      {
        ...held,
        id: 5,
        pull_requests: [{ number: 99, head: { sha: verificationSha } }],
      },
      { ...held, id: 6, head_repository: { full_name: "fork/repo" } },
      { ...held, id: 7, status: "queued" },
    ],
    checksByPoll: [verificationSuccess().slice(1), verificationSuccess()],
  });
  assert.deepEqual(result.approved, [1]);
  assert.equal(result.checkPoll, 2);
  assert.deepEqual(result.failures, []);
});
test("candidate verifier requires all CodeQL analyses and trusted producer identity", async () => {
  const checks = verificationSuccess();
  for (const overrides of [
    { 101: { path: ".github/workflows/evil.yml" } },
    { 101: { head_sha: "b".repeat(40) } },
    { 101: { event: "push" } },
  ]) {
    const result = await runCandidateVerification({
      producerOverrides: overrides,
    });
    assert.match(result.failures[0], /untrusted|binding/);
  }
  const missing = await runCandidateVerification({
    checksByPoll: [checks.slice(0, -1)],
  });
  assert.match(missing.failures[0], /Timed out/);
  const failed = await runCandidateVerification({
    checksByPoll: [
      checks.map((c) =>
        c.name === "Analyze (python)" ? { ...c, conclusion: "failure" } : c,
      ),
    ],
  });
  assert.match(failed.failures[0], /CodeQL\(python\):failure/);
  for (const name of ["automation-policy", "Analyze (python)"]) {
    const neutral = await runCandidateVerification({
      checksByPoll: [
        checks.map((c) =>
          c.name === name ? { ...c, conclusion: "neutral" } : c,
        ),
      ],
    });
    assert.match(neutral.failures[0], /neutral/);
  }
});
test("candidate verifier refuses a moved PR before granting held workflow execution", async () => {
  const result = await runCandidateVerification({
    pullHead: "b".repeat(40),
    runs: [{ ...verificationRun(101), conclusion: "action_required" }],
  });
  assert.deepEqual(result.approved, []);
  assert.match(result.failures[0], /changed|binding/);
});
test("candidate verifier propagates held workflow approval denial", async () => {
  await assert.rejects(
    runCandidateVerification({
      runs: [{ ...verificationRun(101), conclusion: "action_required" }],
      approveError: new Error("Approval denied"),
    }),
    /Approval denied/,
  );
});
test("candidate verification checks out trusted controls only and preserves execution isolation", () => {
  const workflow = fs.readFileSync(
    new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
    "utf8",
  );
  const job = workflow.slice(
    workflow.indexOf("\n  verify-candidate:"),
    workflow.indexOf("\n  finalize:"),
  );
  assert.match(job, /ref: \$\{\{ needs.build.outputs.source-sha \}\}/);
  assert.match(job, /contents: read/);
  assert.match(job, /collectCandidateChecks/);
  assert.doesNotMatch(job, /\bnpm(?:\s|$)/m);
  for (const [from, to] of [
    ["needs.build.outputs.source-sha", "needs.build.outputs.candidate-sha"],
    ["collectCandidateChecks", "fakeChecks"],
    [
      "github.rest.actions.approveWorkflowRun",
      "github.rest.actions.getWorkflowRun",
    ],
    ["actions: write", "actions: read"],
  ])
    assert.equal(
      validateWorkflowContract(workflow.replace(job, job.replaceAll(from, to)))
        .ok,
      false,
      from,
    );
});

test("TypeScript CI independently enforces the automation policy", () => {
  const workflow = fs.readFileSync(
    new URL("../workflows/typescript.yml", import.meta.url),
    "utf8",
  );

  assert.deepEqual(validateCiContract(workflow), { ok: true, reasons: [] });
  assert.equal(
    validateCiContract(
      workflow.replace(
        "  pull_request:\n    branches: [main]",
        '  pull_request:\n    branches: [main]\n    paths:\n      - "typescript/**"',
      ),
    ).ok,
    false,
  );
  assert.equal(
    validateCiContract(
      workflow.replace(
        "  push:\n",
        '  push:\n    paths:\n      - "typescript/**"\n',
      ),
    ).ok,
    false,
    "a paths filter on the push trigger must fail the contract — verify-main needs every main commit to produce the required checks",
  );
});

test("requires one repository-global serial builder and dispatch-only triggers", () => {
  const workflow = fs.readFileSync(
    new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
    "utf8",
  );

  const groupLine = workflow
    .split("\n")
    .find((line) => /^\s{2}group:/.test(line));
  assert.ok(groupLine);
  assert.equal(
    groupLine.trim(),
    "group: jarvis-autobuild-${{ github.repository }}",
    "the concurrency group must be repository-wide so only one worker runs",
  );
  assert.doesNotMatch(
    groupLine,
    /issue-|inputs\.issue_number|github\.event\.issue/,
  );
  assert.match(workflow, /cancel-in-progress:\s*false/);

  // The builder must not be started by a label; that routing belongs to
  // jarvis-queue-advance.yml.
  const onBlock = /^on:([\s\S]*?)\npermissions:/m.exec(workflow)?.[1] ?? "";
  assert.doesNotMatch(onBlock, /\bissues:/);
  assert.doesNotMatch(onBlock, /\bpull_request:/);
  assert.match(onBlock, /workflow_dispatch:/);

  const issueTriggered = workflow.replace(
    /^on:\n/m,
    "on:\n  issues:\n    types: [labeled]\n",
  );
  assert.equal(
    validateWorkflowContract(issueTriggered).ok,
    false,
    "an issue trigger on the builder must fail the contract",
  );

  const perIssueGroup = workflow.replace(
    "group: jarvis-autobuild-${{ github.repository }}",
    "group: jarvis-autobuild-${{ github.repository }}-issue-${{ inputs.issue_number }}",
  );
  assert.equal(
    validateWorkflowContract(perIssueGroup).ok,
    false,
    "a per-issue concurrency group must fail the contract",
  );
});

test("candidate verifier approves dynamic managed scanning by exact PR ref without pull_requests entries", async () => {
  const scanning = {
    ...verificationRun(105),
    pull_requests: [],
    conclusion: "action_required",
  };
  const result = await runCandidateVerification({
    runs: [
      scanning,
      { ...scanning, id: 205, head_branch: "refs/pull/13/head" },
      { ...scanning, id: 305, path: "dynamic/github-code-quality/codeql" },
    ],
  });
  assert.deepEqual(result.approved, [105]);
  assert.deepEqual(result.failures, []);
});
