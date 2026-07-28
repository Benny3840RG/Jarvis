import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  evaluateDiff,
  evaluateIssue,
  redactReceipt,
  validatePromptContract,
  validateWorkflowContract,
} from "./validate-autobuild.mjs";

const eligibleIssue = {
  state: "open",
  labels: ["automation-approved"],
  body: "## Acceptance criteria\n\n- [ ] Add the requested behaviour\n- [ ] Cover it with tests",
  hasExistingAutomationPr: false,
};

test("accepts a single approved open issue with acceptance criteria", () => {
  assert.deepEqual(evaluateIssue(eligibleIssue), { ok: true, reasons: [] });
});

test("rejects closed, unapproved, locked, duplicate, or underspecified issues", () => {
  const cases = [
    [{ ...eligibleIssue, state: "closed" }, "issue is not open"],
    [{ ...eligibleIssue, labels: [] }, "automation-approved label is missing"],
    [
      { ...eligibleIssue, labels: ["automation-approved", "automation-in-progress"] },
      "automation-in-progress lock is already present",
    ],
    [{ ...eligibleIssue, hasExistingAutomationPr: true }, "automation pull request already exists"],
    [{ ...eligibleIssue, body: "Please fix it." }, "testable acceptance criteria are missing"],
  ];

  for (const [input, reason] of cases) {
    const result = evaluateIssue(input);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes(reason), `${reason}: ${result.reasons.join(", ")}`);
  }
});

test("accepts bounded source and test changes", () => {
  const result = evaluateDiff({
    files: [
      { path: "typescript/src/example.ts", status: "M", additions: 10, deletions: 2 },
      { path: "typescript/tests/example.test.ts", status: "A", additions: 24, deletions: 0 },
    ],
  });

  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("requires a test change when source changes", () => {
  const result = evaluateDiff({
    files: [{ path: "typescript/src/example.ts", status: "M", additions: 10, deletions: 2 }],
  });

  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("source changes require a matching test change"));
});

test("rejects forbidden control, dependency, schema, deployment, binary, and symlink changes", () => {
  const forbidden = [
    ".github/workflows/evil.yml",
    ".github/automation/validate-autobuild.mjs",
    ".env.local",
    "typescript/package.json",
    "typescript/package-lock.json",
    "typescript/convex/schema.ts",
    "convex.json",
  ];

  for (const path of forbidden) {
    const result = evaluateDiff({
      files: [{ path, status: "M", additions: 1, deletions: 0 }],
    });
    assert.equal(result.ok, false, path);
    assert.ok(result.reasons.some((reason) => reason.includes(path)), path);
  }

  for (const file of [
    { path: "typescript/src/link.ts", status: "A", additions: 1, deletions: 0, symlink: true },
    { path: "typescript/src/blob.bin", status: "A", additions: 1, deletions: 0, binary: true },
  ]) {
    assert.equal(evaluateDiff({ files: [file] }).ok, false, file.path);
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
  assert.ok(evaluateDiff({ files: tooManyFiles }).reasons.includes("changed file limit exceeded"));

  assert.ok(
    evaluateDiff({
      files: [{ path: "docs/large.md", status: "M", additions: 2_001, deletions: 0 }],
    }).reasons.includes("diff line limit exceeded"),
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

  assert.deepEqual(validateWorkflowContract(workflow), { ok: true, reasons: [] });
});
