import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSpecHash,
  deriveDevelopmentSubjectId,
  validateGithubIssueSpecification,
  type GithubIssueSnapshot,
} from "../src/development/specValidation.js";

function issue(overrides: Partial<GithubIssueSnapshot> = {}): GithubIssueSnapshot {
  return {
    owner: "Benny3840RG",
    repo: "Jarvis",
    issueNumber: 500,
    title: "Add rate limiting to the quote delivery endpoint",
    body: [
      "We need to bound retry volume on the delivery endpoint.",
      "",
      "Acceptance criteria:",
      "- [ ] Requests beyond the configured rate are rejected with 429",
      "- [ ] The limit is configurable via an env var",
    ].join("\n"),
    labels: ["jarvis:autonomous-ok"],
    state: "open",
    htmlUrl: "https://github.com/Benny3840RG/Jarvis/issues/500",
    ...overrides,
  };
}

test("a well-formed open issue with acceptance criteria produces a valid specification", () => {
  const result = validateGithubIssueSpecification(issue(), {
    requiredLabels: ["jarvis:autonomous-ok"],
  });

  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(
      result.specification.objective,
      "Add rate limiting to the quote delivery endpoint",
    );
    assert.equal(result.specification.acceptanceCriteria.length, 2);
    assert.equal(
      result.specification.acceptanceCriteria[0],
      "Requests beyond the configured rate are rejected with 429",
    );
    assert.equal(result.specification.sourceIssue.issueNumber, 500);
  }
});

test("a closed issue is rejected", () => {
  const result = validateGithubIssueSpecification(issue({ state: "closed" }), {});

  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.reasons.includes("ISSUE_NOT_OPEN"));
});

test("an issue with no acceptance criteria is rejected, reusing Omega's own reason vocabulary", () => {
  // Deliberately the same string src/omega/policy.ts#evaluateOmegaCompletion
  // uses for the identical concept, since these will eventually bridge to
  // omegaMissions.create's acceptanceCriteria -- one vocabulary, not two.
  const result = validateGithubIssueSpecification(
    issue({
      body: "Just some prose with no checklist at all, but long enough to pass the length gate on its own merits, twice over even.",
    }),
    {},
  );

  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.reasons.includes("no-acceptance-criteria"));
});

test("an issue missing a required governance label is rejected", () => {
  const result = validateGithubIssueSpecification(issue({ labels: [] }), {
    requiredLabels: ["jarvis:autonomous-ok"],
  });

  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.reasons.includes("MISSING_REQUIRED_LABEL"));
});

test("an issue with too short a body is rejected", () => {
  const result = validateGithubIssueSpecification(issue({ body: "too short" }), {});

  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.reasons.includes("BODY_TOO_SHORT"));
});

test("an issue with an excessively long title is rejected", () => {
  const result = validateGithubIssueSpecification(issue({ title: "x".repeat(300) }), {});

  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.reasons.includes("TITLE_TOO_LONG"));
});

test("deriveDevelopmentSubjectId is deterministic and stable for the same issue", () => {
  const a = deriveDevelopmentSubjectId({ owner: "Benny3840RG", repo: "Jarvis", issueNumber: 500 });
  const b = deriveDevelopmentSubjectId({ owner: "Benny3840RG", repo: "Jarvis", issueNumber: 500 });
  const different = deriveDevelopmentSubjectId({
    owner: "Benny3840RG",
    repo: "Jarvis",
    issueNumber: 501,
  });

  assert.equal(a, b);
  assert.notEqual(a, different);
});

test("computeSpecHash is stable for identical content and changes when content changes", () => {
  const result = validateGithubIssueSpecification(issue(), {});
  assert.equal(result.valid, true);
  if (!result.valid) return;

  const again = validateGithubIssueSpecification(issue(), {});
  assert.equal(again.valid, true);
  if (!again.valid) return;

  assert.equal(result.specification.specHash, again.specification.specHash);

  const changed = validateGithubIssueSpecification(
    issue({ title: "A materially different objective" }),
    {},
  );
  assert.equal(changed.valid, true);
  if (!changed.valid) return;

  assert.notEqual(result.specification.specHash, changed.specification.specHash);
});

test("computeSpecHash is directly computable and matches what validation produces", () => {
  const result = validateGithubIssueSpecification(issue(), {});
  assert.equal(result.valid, true);
  if (!result.valid) return;

  const recomputed = computeSpecHash({
    objective: result.specification.objective,
    acceptanceCriteria: result.specification.acceptanceCriteria,
  });

  assert.equal(recomputed, result.specification.specHash);
});
