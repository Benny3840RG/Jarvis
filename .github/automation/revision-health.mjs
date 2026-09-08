// Shared, pure evaluation of whether a specific commit on `main` is healthy.
//
// Used by two callers, both of which must reach the same verdict for the same
// SHA:
//   - jarvis-queue-advance.yml `verify-main` (before dispatching a mission)
//   - jarvis-autobuild.yml `Verify the dispatched source revision` (before the
//     builder checks that SHA out and starts work)
//
// The API-calling / polling loop stays in the workflows; this module owns the
// producer-trust and coverage rules so they cannot drift between the two.

// Required status checks and the ONLY workflow allowed to produce each.
export const REQUIRED_WORKFLOW_CHECKS = {
  "automation-policy": ".github/workflows/typescript.yml",
  "typecheck-lint-format-test": ".github/workflows/typescript.yml",
  "jarvis-console-01-build": ".github/workflows/typescript.yml",
};

// GitHub managed code scanning publishes one check per language, named
// `Analyze (<language>)`. There is no aggregate `CodeQL` check on `main` pushes.
export const EXPECTED_CODEQL_LANGUAGES = [
  "actions",
  "python",
  "ruby",
  "javascript-typescript",
];

// The trusted producer for those analyses.
export const TRUSTED_CODEQL_PATH_PREFIX = "dynamic/github-code-scanning/";

export function runIdFromCheck(check) {
  return Number(
    /\/actions\/runs\/(\d+)/.exec(check?.details_url || check?.html_url || "")?.[1],
  );
}

const analyzeLanguage = (name) => /^Analyze \(([^)]+)\)\s*$/.exec(String(name ?? ""))?.[1];

/** Every workflow-run id referenced by a check that participates in the verdict. */
export function referencedRunIds(checkRuns = []) {
  const ids = new Set();
  for (const check of checkRuns) {
    const relevant =
      Object.prototype.hasOwnProperty.call(REQUIRED_WORKFLOW_CHECKS, check?.name) ||
      analyzeLanguage(check?.name) !== undefined;
    if (!relevant) continue;
    const id = runIdFromCheck(check);
    if (Number.isSafeInteger(id)) ids.add(id);
  }
  return ids;
}

/**
 * @param checkRuns  check-run objects for the SHA (name, status, conclusion,
 *                   app.slug, details_url/html_url, id)
 * @param runPathById  Map<number, string> of workflow-run id -> run `.path`
 * @returns { ok, problems, pending }
 *   - `problems`: hard failures (wrong producer, non-success conclusion) — never dispatch
 *   - `pending`: expected checks not complete yet — keep waiting, then fail closed
 */
export function evaluateRevisionHealth({ checkRuns = [], runPathById = new Map() } = {}) {
  const problems = [];
  const pending = [];

  for (const [name, workflowPath] of Object.entries(REQUIRED_WORKFLOW_CHECKS)) {
    const run = checkRuns
      .filter((check) => check.name === name && check.app?.slug === "github-actions")
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!run || run.status !== "completed") {
      pending.push(name);
      continue;
    }
    if (runPathById.get(runIdFromCheck(run)) !== workflowPath) {
      problems.push(`${name}: untrusted producer`);
      continue;
    }
    if (run.conclusion !== "success") {
      problems.push(`${name}:${run.conclusion || "unknown"}`);
    }
  }

  const perLanguage = new Map();
  for (const check of checkRuns) {
    const language = analyzeLanguage(check.name);
    if (!language || check.app?.slug !== "github-actions") continue;
    const path = runPathById.get(runIdFromCheck(check)) || "";
    if (!path.startsWith(TRUSTED_CODEQL_PATH_PREFIX)) continue;
    perLanguage.set(language, { status: check.status, conclusion: check.conclusion });
  }
  for (const language of EXPECTED_CODEQL_LANGUAGES) {
    const analysis = perLanguage.get(language);
    if (!analysis || analysis.status !== "completed") {
      pending.push(`CodeQL(${language})`);
      continue;
    }
    // `neutral` / `skipped` are not success.
    if (analysis.conclusion !== "success") {
      problems.push(`CodeQL(${language}):${analysis.conclusion || "unknown"}`);
    }
  }

  return { ok: problems.length === 0 && pending.length === 0, problems, pending };
}

/**
 * Accept a candidate source SHA only when it is `main` itself or an ancestor of
 * `main` (never a sibling, fork point, or force-push target).
 * @param compareStatus  `repos.compareCommitsWithBasehead` status for
 *                        `<sourceSha>...main`
 */
export function sourceRevisionIsOnMain(compareStatus) {
  return compareStatus === "identical" || compareStatus === "ahead";
}
