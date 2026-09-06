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
  validateWorkflowContract,
} from "./validate-autobuild.mjs";

const eligibleIssue = {
  state: "open",
  labels: ["automation-approved"],
  body: "## Acceptance criteria\n\n- [ ] Add the requested behaviour\n- [ ] Cover it with tests",
  hasExistingAutomationPr: false,
};

async function finalizeRun(overrides = {}) {
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
  const env = {
    ISSUE_NUMBER: "435",
    BUILD_RESULT: "failure",
    VERIFY_RESULT: "skipped",
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
  )(context, github, { setFailed: assert.fail }, { env });
  const body = comments.join("\n");
  const match = body.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(
    match,
    "finalization must persist its diagnostic receipt in the issue",
  );
  return { body, receipt: JSON.parse(match[1]), statuses, labels };
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
  assert.match(workflow, /actions\/permissions\/workflow/);
  assert.match(workflow, /can_create_pull_request/);
  assert.match(workflow, /can_approve_pull_request_reviews/);

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
    /name: Release issue lock after build[\s\S]*if: always\(\) && steps\.eligibility\.outputs\.lock_acquired == 'true'/,
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
    /(\n  finalize:[\s\S]*?\n    if: >-\n)([\s\S]*?)(\n    runs-on:)/,
    "$1      always()$3",
  );
  assert.equal(validateWorkflowContract(unrelatedFinalize).ok, false);

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
  assert.equal(
    validateWorkflowContract(
      workflow.replace(
        "actions/permissions/workflow",
        "actions/permissions",
      ),
    ).ok,
    false,
    "workflow must preflight the explicit Actions workflow-permission endpoint",
  );
  assert.equal(
    validateWorkflowContract(
      workflow.replace(
        "can_create_pull_request",
        "can_build_pull_request",
      ),
    ).ok,
    false,
    "workflow must preflight draft PR creation capability explicitly",
  );
});

test("candidate verification approves exact-head PR runs without executing candidate content", () => {
  const workflow = fs.readFileSync(
    new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
    "utf8",
  );
  const verifyStart = workflow.indexOf("\n  verify-candidate:");
  const finalizeStart = workflow.indexOf("\n  finalize:", verifyStart);
  const verifyJob = workflow.slice(verifyStart, finalizeStart);

  assert.match(verifyJob, /actions:\s*write/);
  assert.match(verifyJob, /github\.rest\.actions\.listWorkflowRunsForRepo/);
  assert.match(verifyJob, /head_sha:\s*candidateSha/);
  assert.match(verifyJob, /event:\s*"pull_request"/);
  assert.match(verifyJob, /run\.status !== "action_required"/);
  assert.match(verifyJob, /github\.rest\.actions\.approveWorkflowRun/);
  assert.match(verifyJob, /github\.rest\.checks\.listForRef/);
  assert.match(verifyJob, /CANDIDATE_SHA/);
  assert.doesNotMatch(verifyJob, /actions\/checkout@/);
  assert.doesNotMatch(verifyJob, /actions\/setup-node@/);
  assert.doesNotMatch(verifyJob, /\bnpm(?:\s|$)/m);
  for (const requiredCheck of [
    "automation-policy",
    "typecheck-lint-format-test",
    "jarvis-console-01-build",
    "pr-evidence",
    "CodeQL",
  ]) {
    assert.ok(verifyJob.includes(`"${requiredCheck}"`), requiredCheck);
  }

  assert.equal(
    validateWorkflowContract(
      workflow.replace(
        "github.rest.checks.listForRef",
        "github.rest.checks.listSuitesForRef",
      ),
    ).ok,
    false,
    "verification must query check runs for the candidate SHA",
  );
  assert.equal(
    validateWorkflowContract(
      workflow.replace("actions: write", "actions: read"),
    ).ok,
    false,
    "verification must have permission to approve held PR runs",
  );
  assert.equal(
    validateWorkflowContract(
      workflow.replace(
        "github.rest.actions.listWorkflowRunsForRepo",
        "github.rest.actions.getWorkflowRun",
      ),
    ).ok,
    false,
    "verification must discover held runs for the candidate SHA",
  );
  assert.equal(
    validateWorkflowContract(
      workflow.replace(
        "github.rest.actions.approveWorkflowRun",
        "github.rest.actions.getWorkflowRun",
      ),
    ).ok,
    false,
    "verification must approve held candidate PR runs",
  );
  assert.equal(
    validateWorkflowContract(
      workflow.replace(
        "      - name: Wait for required PR-scoped checks",
        "      - name: Unsafe candidate execution\n        run: npm ci\n\n      - name: Wait for required PR-scoped checks",
      ),
    ).ok,
    false,
    "verification must reject candidate npm execution",
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
});

test("requires issue-scoped concurrency and preserves duplicate-issue serialization", () => {
  const workflow = fs.readFileSync(
    new URL("../workflows/jarvis-autobuild.yml", import.meta.url),
    "utf8",
  );

  const issueScopedGroup =
    /^\s{2}group:\s*jarvis-autobuild-\$\{\{\s*github\.repository\s*\}\}-\$\{\{(?=.*github\.event_name)(?=.*inputs\.issue_number)(?=.*github\.event\.issue\.number).*?\}\}\s*$/im;
  assert.match(workflow, issueScopedGroup);
  const groupLine = workflow
    .split("\n")
    .find((line) => /^\s{2}group:/.test(line));
  assert.ok(groupLine);
  assert.match(groupLine, /format\('issue-\{0\}',\s*inputs\.issue_number\)/);
  assert.match(
    groupLine,
    /format\('issue-\{0\}',\s*github\.event\.issue\.number\)/,
  );
  assert.doesNotMatch(
    groupLine,
    /inputs\.issue_number\s*\|\|\s*github\.event\.issue\.number/,
  );

  const groupForIssue = (issueNumber) =>
    "jarvis-autobuild-Benny3840RG/Jarvis-issue-" + issueNumber;
  assert.notEqual(groupForIssue(331), groupForIssue(332));
  assert.equal(groupForIssue(331), groupForIssue(331));

  const repositoryWide = workflow.replace(
    /^(\s{2}group:\s*).+$/m,
    "$1jarvis-autobuild-${{ github.repository }}",
  );
  assert.equal(validateWorkflowContract(repositoryWide).ok, false);
});
