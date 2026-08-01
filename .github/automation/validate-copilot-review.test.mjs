import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveReviewSource,
  validateReviewBody,
  validateSourceTestCoverage,
} from "./validate-copilot-review.mjs";

const filledReview = `# Copilot Review

- CLI Contract: N/A — no CLI commands or flags are modified by this change.
- Persistence Providers: N/A — no JSON or Convex provider code is touched here.
- Backup / Restore: N/A — no backup or restore paths are modified in this PR.
- HTTP / MCP: N/A — no HTTP operator API or MCP surface is changed here.
- Tests & Checks: N/A — no typescript/src or convex runtime source changed, so no new tests.
- Documentation: gitignore documents that .github/home is generated and must not be committed.
`;

const placeholderReview = `# Copilot Review

- CLI Contract: [...]
- Persistence Providers: [...]
- Backup / Restore: [...]
- HTTP / MCP: [...]
- Tests & Checks: [...]
- Documentation: [...]
`;

test("rejects placeholder Copilot Review lines", () => {
  const failures = validateReviewBody(placeholderReview);
  assert.equal(failures.length, 6);
  assert.match(failures[0], /CLI Contract.*placeholder/);
});

test("accepts filled N/A reasons", () => {
  assert.deepEqual(validateReviewBody(filledReview), []);
});

test("rejects missing Copilot Review section", () => {
  const failures = validateReviewBody("# Summary\n\nNothing here.");
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Copilot Review/);
});

test("rejects bare N/A without a real reason", () => {
  const body = filledReview.replace(
    "N/A — no CLI commands or flags are modified by this change.",
    "N/A — short",
  );
  const failures = validateReviewBody(body);
  assert.ok(failures.some((f) => f.includes("CLI Contract") && f.includes("without a real reason")));
});

test("prefers a valid PR body over pull_request_update", () => {
  const result = resolveReviewSource(filledReview, placeholderReview);
  assert.deepEqual(result, {
    failures: [],
    reviewSource: "pull request description",
  });
});

test("falls back to pull_request_update when PR body is incomplete", () => {
  const result = resolveReviewSource(placeholderReview, filledReview);
  assert.deepEqual(result, {
    failures: [],
    reviewSource: ".github/pull_request_update",
  });
});

test("reports both sources incomplete when neither is valid", () => {
  const result = resolveReviewSource(placeholderReview, placeholderReview);
  assert.equal(result.reviewSource, "none");
  assert.ok(result.failures[0].includes("pull_request_update is also incomplete"));
  assert.ok(result.failures.length > 1);
});

test("keeps PR body failures when update file is absent", () => {
  const result = resolveReviewSource(placeholderReview, "");
  assert.equal(result.reviewSource, "none");
  assert.equal(result.failures.length, 6);
});

test("flags source changes without tests", () => {
  const failures = validateSourceTestCoverage([
    "typescript/src/cli.ts",
    "README.md",
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /touches no test file/);
});

test("allows source changes when tests are included", () => {
  assert.deepEqual(
    validateSourceTestCoverage([
      "typescript/src/cli.ts",
      "typescript/tests/cli.wiring.test.ts",
    ]),
    [],
  );
});
