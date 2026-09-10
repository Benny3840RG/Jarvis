import { createHash } from "node:crypto";
import {
  REQUIRED_WORKFLOW_CHECKS,
  EXPECTED_CODEQL_LANGUAGES,
  TRUSTED_CODEQL_PATH_PREFIX,
  evaluateRevisionHealth,
  runIdFromCheck,
} from "./revision-health.mjs";

const SHA = /^[0-9a-f]{40}$/;
const MAX_REVIEW_BYTES = 32_768;
const MAX_CONTEXT_BYTES = 160 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const PR_EVIDENCE_PATH = ".github/workflows/copilot-check.yml";
const REQUIRED_NAMES = new Set([
  ...Object.keys(REQUIRED_WORKFLOW_CHECKS),
  "pr-evidence",
  ...EXPECTED_CODEQL_LANGUAGES.map((language) => `Analyze (${language})`),
]);

function plainObject(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function textField(value, max) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !value.includes("\0")
  );
}

function safePath(value) {
  return (
    textField(value, 1024) &&
    !value.startsWith("/") &&
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Model output is an advisory data record. It never supplies executable authority. */
export function parseReview(raw) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > MAX_REVIEW_BYTES
  )
    throw new Error("Review output exceeds its byte limit.");
  const value = JSON.parse(raw);
  if (
    !plainObject(value, ["verdict", "summary", "findings"]) ||
    !["pass", "changes_requested", "blocked"].includes(value.verdict) ||
    !textField(value.summary, 4000) ||
    !Array.isArray(value.findings) ||
    value.findings.length > 50
  )
    throw new Error("Invalid review record.");
  for (const finding of value.findings) {
    if (
      !plainObject(finding, ["file", "line", "severity", "message"]) ||
      !safePath(finding.file) ||
      !Number.isSafeInteger(finding.line) ||
      finding.line < 1 ||
      !["high", "medium", "low"].includes(finding.severity) ||
      !textField(finding.message, 4000)
    ) {
      throw new Error("Invalid review finding.");
    }
  }
  if (
    (value.verdict === "pass" && value.findings.length !== 0) ||
    (value.verdict === "changes_requested" && value.findings.length === 0)
  )
    throw new Error("Review verdict disagrees with its findings.");
  return value;
}

function producerPath(name) {
  return name === "pr-evidence"
    ? PR_EVIDENCE_PATH
    : (REQUIRED_WORKFLOW_CHECKS[name] ?? TRUSTED_CODEQL_PATH_PREFIX);
}

/** GitHub managed scanning uses dynamic events and a refs/pull/N/head binding. */
export function candidateRunEventMatches(run, pullNumber) {
  const scanning =
    run?.path?.startsWith(TRUSTED_CODEQL_PATH_PREFIX) ||
    run?.path === "dynamic/github-code-quality/codeql";
  if (!scanning) return run?.event === "pull_request";
  if (!["dynamic", "pull_request"].includes(run?.event)) return false;
  if (pullNumber !== undefined)
    return (
      Number.isSafeInteger(pullNumber) &&
      pullNumber > 0 &&
      run.head_branch === `refs/pull/${pullNumber}/head`
    );
  return (
    run.event === "pull_request" ||
    /^refs\/pull\/[1-9][0-9]*\/head$/.test(run.head_branch || "")
  );
}

/** Exact head and trusted PR event/ref binding extend the shared main-health policy. */
export function evaluateCandidateChecks({
  checkRuns = [],
  runs = new Map(),
  headSha,
  pullNumber,
} = {}) {
  const problems = [];
  if (!SHA.test(headSha ?? ""))
    return { ok: false, problems: ["invalid candidate SHA"], pending: [] };
  const runPathById = new Map();
  for (const check of checkRuns) {
    if (!REQUIRED_NAMES.has(check.name)) continue;
    const runId = runIdFromCheck(check);
    const run = runs.get(runId);
    const path = producerPath(check.name);
    // Code quality is a distinct managed product. Its duplicate Analyze names
    // neither satisfy nor veto the required code-scanning language checks.
    if (
      check.name.startsWith("Analyze (") &&
      run?.path === "dynamic/github-code-quality/codeql" &&
      run.id === runId &&
      run.head_sha === headSha &&
      check.head_sha === headSha &&
      check.app?.slug === "github-actions" &&
      candidateRunEventMatches(run, pullNumber)
    )
      continue;
    if (
      !Number.isSafeInteger(check.id) ||
      check.id <= 0 ||
      check.head_sha !== headSha ||
      check.app?.slug !== "github-actions" ||
      !run ||
      run.id !== runId ||
      run.head_sha !== headSha ||
      !candidateRunEventMatches(run, pullNumber) ||
      typeof run.path !== "string" ||
      !(path.endsWith("/") ? run.path.startsWith(path) : run.path === path)
    ) {
      problems.push(`${check.name}: untrusted producer or candidate binding`);
      continue;
    }
    runPathById.set(runId, run.path);
  }
  const health = evaluateRevisionHealth({ checkRuns, runPathById });
  problems.push(...health.problems);
  const pending = [...health.pending];
  const evidence = checkRuns
    .filter((check) => check.name === "pr-evidence")
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (!evidence || evidence.status !== "completed") pending.push("pr-evidence");
  else if (evidence.conclusion !== "success")
    problems.push(`pr-evidence:${evidence.conclusion || "unknown"}`);
  return {
    ok: problems.length === 0 && pending.length === 0,
    problems: [...new Set(problems)],
    pending: [...new Set(pending)],
  };
}

export function maintenanceDisposition({
  ci,
  review,
  repairEligible,
  repairCount,
}) {
  if (
    !ci ||
    !Array.isArray(ci.problems) ||
    !Array.isArray(ci.pending) ||
    !Number.isSafeInteger(repairCount) ||
    repairCount < 0
  )
    return "blocked";
  if (review?.verdict === "blocked") return "blocked";
  // Missing authority/provenance cannot be repaired by changing application code.
  if (
    ci.problems.some((problem) =>
      /untrusted|binding|invalid|incomplete/i.test(problem),
    )
  )
    return "blocked";
  if (!ci.ok && ci.problems.length === 0) return "waiting-ci";
  const needsRepair =
    ci.problems.length > 0 || review?.verdict === "changes_requested";
  if (needsRepair) {
    if (!repairEligible) return "owner-repair-required";
    return repairCount >= 2 ? "blocked" : "repair";
  }
  return ci.ok && review?.verdict === "pass" ? "awaiting-owner" : "blocked";
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Bounded complete pagination. A lookup failure is unavailable evidence, never green CI. */
export async function collectCandidateChecks({
  github,
  owner,
  repo,
  headSha,
  pullNumber,
}) {
  if (!SHA.test(headSha ?? "")) throw new Error("Invalid candidate SHA.");
  const checkRuns = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= 20; page++) {
    const { data } = await github.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      filter: "latest",
      per_page: 100,
      page,
    });
    if (
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 0 ||
      data.total_count > 2000 ||
      (total !== undefined && total !== data.total_count) ||
      !Array.isArray(data.check_runs)
    )
      throw new Error("Incomplete candidate checks.");
    total = data.total_count;
    for (const check of data.check_runs) {
      if (
        !Number.isSafeInteger(check.id) ||
        check.id <= 0 ||
        seen.has(check.id)
      )
        throw new Error("Incomplete or duplicated candidate checks.");
      seen.add(check.id);
      checkRuns.push(check);
    }
    if (checkRuns.length === total) break;
    if (checkRuns.length > total || data.check_runs.length === 0 || page === 20)
      throw new Error("Incomplete candidate checks.");
  }
  const runs = new Map();
  for (const check of checkRuns) {
    if (!REQUIRED_NAMES.has(check.name)) continue;
    const url = new URL(
      check.details_url || check.html_url || "https://invalid.invalid",
    );
    const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/|$)/.exec(
      url.pathname,
    );
    if (
      url.origin !== "https://github.com" ||
      !match ||
      match[1].toLowerCase() !== owner.toLowerCase() ||
      match[2].toLowerCase() !== repo.toLowerCase()
    )
      throw new Error("Invalid candidate check producer URL.");
    const id = Number(match[3]);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error("Invalid candidate workflow run ID.");
    if (!runs.has(id)) {
      const { data } = await github.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: id,
      });
      runs.set(id, data);
    }
  }
  const ci = evaluateCandidateChecks({ checkRuns, runs, headSha, pullNumber });
  const snapshot = {
    headSha,
    checks: checkRuns
      .filter((check) => REQUIRED_NAMES.has(check.name))
      .map((check) => ({
        id: check.id,
        name: check.name,
        headSha: check.head_sha ?? null,
        app: check.app?.slug ?? null,
        status: check.status ?? null,
        conclusion: check.conclusion ?? null,
        runId: runIdFromCheck(check),
      }))
      .sort((a, b) => a.id - b.id),
    runs: [...runs.values()]
      .map((run) => ({
        id: run.id ?? null,
        headSha: run.head_sha ?? null,
        event: run.event ?? null,
        path: run.path ?? null,
        attempt: run.run_attempt ?? null,
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
      }))
      .sort((a, b) => a.id - b.id),
  };
  const fingerprint = createHash("sha256")
    .update(canonical(snapshot))
    .digest("hex");
  return { checkRuns, runs, headSha, ci, fingerprint };
}

/** Fetch full before/after contents; truncated patches are never represented as a full review. */
export async function collectReviewContext({
  github,
  owner,
  repo,
  headSha,
  baseSha,
  files,
  changedFiles,
}) {
  if (
    !SHA.test(headSha ?? "") ||
    !SHA.test(baseSha ?? "") ||
    !Array.isArray(files) ||
    files.length !== changedFiles ||
    files.length === 0 ||
    files.length > 40
  )
    throw new Error("Incomplete or oversized review file list.");
  const seen = new Set();
  let totalBytes = 0;
  const read = async (path, ref) => {
    const { data } = await github.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    if (
      !data ||
      data.type !== "file" ||
      data.encoding !== "base64" ||
      typeof data.content !== "string" ||
      !Number.isSafeInteger(data.size) ||
      data.size < 0 ||
      data.size > MAX_FILE_BYTES ||
      data.content.length > MAX_FILE_BYTES * 2
    )
      throw new Error(`Unavailable or oversized text file: ${path}`);
    const encoded = data.content.replace(/\s/g, "");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length !== data.size)
      throw new Error(`Incomplete file content: ${path}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_CONTEXT_BYTES || bytes.includes(0))
      throw new Error("Review context is oversized or binary.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  const context = [];
  for (const file of files) {
    if (
      !safePath(file.filename) ||
      seen.has(file.filename) ||
      !["added", "modified", "removed", "renamed"].includes(file.status) ||
      (file.status === "renamed" && !safePath(file.previous_filename))
    )
      throw new Error("Invalid review file entry.");
    seen.add(file.filename);
    const beforePath =
      file.status === "renamed" ? file.previous_filename : file.filename;
    const before =
      file.status === "added" ? null : await read(beforePath, baseSha);
    const after =
      file.status === "removed" ? null : await read(file.filename, headSha);
    context.push({
      filename: file.filename,
      status: file.status,
      ...(file.status === "renamed" ? { previousFilename: beforePath } : {}),
      before,
      after,
    });
  }
  return context;
}
