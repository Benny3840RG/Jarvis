const REQUIRED_HEADINGS = [
  "CLI Contract",
  "Persistence Providers",
  "Backup / Restore",
  "HTTP / MCP",
  "Tests & Checks",
  "Documentation",
];

const MIN_CONTENT_LENGTH = 12;
const FILLER_PATTERNS = [
  /^n\/?a$/i,
  /^(none|nope|ok|okay|done|yes|no)\.?$/i,
  /^(lgtm|looks good( to me)?|ship it)\.?$/i,
  /^no (issues|regressions|changes)\.?$/i,
  /^tested\.?$/i,
];
const NA_WITH_REASON = /^n\/a\s*[—-]\s*(.+)/i;

/**
 * Validate a Copilot Review section body (PR description or pull_request_update).
 * @param {string} body
 * @returns {string[]} failure messages; empty when valid
 */
export function validateReviewBody(body = "") {
  const failures = [];
  if (!body.includes("Copilot Review")) {
    failures.push(
      "PR description must include a '# Copilot Review' section (see .github/PULL_REQUEST_TEMPLATE.md).",
    );
    return failures;
  }

  for (const heading of REQUIRED_HEADINGS) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`-\\s*${escaped}\\s*:\\s*(.+)`);
    const match = body.match(pattern);
    if (!match) {
      failures.push(`Copilot Review is missing the "${heading}" line.`);
      continue;
    }
    const content = match[1].trim();
    if (content.length === 0 || content === "[...]") {
      failures.push(
        `Copilot Review's "${heading}" line is still a placeholder — fill it in with an actual finding (or "N/A — <reason>").`,
      );
      continue;
    }

    const naMatch = content.match(NA_WITH_REASON);
    if (naMatch) {
      if (naMatch[1].trim().length < MIN_CONTENT_LENGTH) {
        failures.push(
          `Copilot Review's "${heading}" line gives "N/A" without a real reason — say why it doesn't apply.`,
        );
      }
      continue;
    }

    if (FILLER_PATTERNS.some((rx) => rx.test(content))) {
      failures.push(
        `Copilot Review's "${heading}" line looks like filler ("${content}") — give a concrete finding tied to the code change, or "N/A — <reason>".`,
      );
      continue;
    }

    if (content.length < MIN_CONTENT_LENGTH) {
      failures.push(
        `Copilot Review's "${heading}" line is too short ("${content}") — give a concrete finding, or "N/A — <reason>".`,
      );
    }
  }
  return failures;
}

/**
 * Choose PR body or .github/pull_request_update as the review source.
 * Prefers a valid PR body; falls back to pull_request_update when the body is incomplete.
 * @param {string} prBody
 * @param {string} updateBody
 * @returns {{ failures: string[], reviewSource: string }}
 */
export function resolveReviewSource(prBody = "", updateBody = "") {
  const bodyFailures = validateReviewBody(prBody);
  if (bodyFailures.length === 0) {
    return { failures: [], reviewSource: "pull request description" };
  }

  if (updateBody && updateBody.trim().length > 0) {
    const updateFailures = validateReviewBody(updateBody);
    if (updateFailures.length === 0) {
      return { failures: [], reviewSource: ".github/pull_request_update" };
    }
    return {
      failures: [
        "PR description Copilot Review is incomplete, and .github/pull_request_update is also incomplete:",
        ...updateFailures,
      ],
      reviewSource: "none",
    };
  }

  return { failures: bodyFailures, reviewSource: "none" };
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
export function validateSourceTestCoverage(paths = []) {
  const failures = [];
  const sourceChanged = paths.some(
    (path) =>
      (path.startsWith("typescript/src/") || path.startsWith("typescript/convex/")) &&
      !path.endsWith(".test.ts"),
  );
  const testsChanged = paths.some(
    (path) =>
      path.startsWith("typescript/tests/") ||
      (path.startsWith("typescript/convex/") && path.endsWith(".test.ts")),
  );
  if (sourceChanged && !testsChanged) {
    failures.push(
      'This PR changes files under typescript/src/ or typescript/convex/ but touches no test file. Add coverage, or explain in Copilot Review\'s "Tests & Checks" line why none is needed.',
    );
  }
  return failures;
}

export const COPILOT_REVIEW_CONSTANTS = {
  REQUIRED_HEADINGS,
  MIN_CONTENT_LENGTH,
};
