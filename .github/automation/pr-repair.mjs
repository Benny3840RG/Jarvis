import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { evaluateDiff, evaluatePatch } from "./validate-autobuild.mjs";
const positive = (value) => Number.isSafeInteger(value) && value > 0;
export function repairRunName(number) {
  if (!positive(number)) throw new Error("Invalid repair PR number");
  return `Jarvis repair PR #${number}`;
}
export function validateRepair({
  issue,
  pull,
  repository,
  issueNumber,
  pullNumber,
  expectedHead,
}) {
  const labels = (x) =>
    new Set((x.labels || []).map((l) => (typeof l === "string" ? l : l.name)));
  if (
    !positive(issueNumber) ||
    !positive(pullNumber) ||
    !/^[0-9a-f]{40}$/.test(expectedHead || "") ||
    issue.number !== issueNumber ||
    issue.state !== "open" ||
    !labels(issue).has("automation-approved") ||
    pull.number !== pullNumber ||
    pull.state !== "open" ||
    pull.base?.ref !== "main" ||
    pull.head?.repo?.full_name !== repository ||
    pull.head?.sha !== expectedHead ||
    !new RegExp(`^automation/issue-${issueNumber}/run-[1-9][0-9]*$`).test(
      pull.head?.ref || "",
    ) ||
    !labels(pull).has("automation-generated")
  )
    throw new Error(
      "Repair candidate identity, approval or exact head is invalid",
    );
  return pull.head.ref;
}
export async function listRepairRuns({ github, owner, repo, pullNumber }) {
  repairRunName(pullNumber);
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  const created = pull.created_at;
  if (
    pull.number !== pullNumber ||
    typeof created !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created) ||
    !Number.isFinite(Date.parse(created)) ||
    new Date(created).toISOString() !== created.replace("Z", ".000Z")
  )
    throw new Error("Invalid repair PR creation timestamp");
  const runs = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= 10; page++) {
    const { data } = await github.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: "jarvis-autobuild.yml",
      event: "workflow_dispatch",
      created: `>=${created}`,
      per_page: 100,
      page,
    });
    if (
      !Array.isArray(data.workflow_runs) ||
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 0 ||
      data.total_count > 1000 ||
      (total !== undefined && total !== data.total_count)
    )
      throw new Error(
        "Repair history is incomplete or changed during pagination",
      );
    total = data.total_count;
    for (const run of data.workflow_runs) {
      if (!positive(run.id) || seen.has(run.id))
        throw new Error("Repair history contains invalid or duplicate runs");
      seen.add(run.id);
      runs.push(run);
    }
    if (runs.length > total)
      throw new Error("Repair history exceeds declared total");
    if (runs.length === total)
      return runs.filter((r) => r.display_title === repairRunName(pullNumber));
    if (data.workflow_runs.length < 100)
      throw new Error("Repair history is incomplete");
  }
  throw new Error("Repair history pagination exhausted");
}
export async function requireRepairBudget({
  github,
  owner,
  repo,
  pullNumber,
  runId,
}) {
  const runs = await listRepairRuns({ github, owner, repo, pullNumber });
  const current = runs.find((r) => Number(r.id) === Number(runId));
  if (
    !current ||
    runs.length > 2 ||
    runs.some(
      (r) =>
        r.run_attempt !== 1 ||
        r.path !== ".github/workflows/jarvis-autobuild.yml" ||
        r.head_branch !== "main" ||
        r.event !== "workflow_dispatch",
    )
  )
    throw new Error("Repair budget exhausted or run provenance invalid");
}
export async function readRepair({
  github,
  owner,
  repo,
  issueNumber,
  pullNumber,
  expectedHead,
}) {
  const [{ data: issue }, { data: pull }] = await Promise.all([
    github.rest.issues.get({ owner, repo, issue_number: issueNumber }),
    github.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
  ]);
  const branch = validateRepair({
    issue,
    pull,
    repository: `${owner}/${repo}`,
    issueNumber,
    pullNumber,
    expectedHead,
  });
  const originalRunId = Number(/\/run-([1-9][0-9]*)$/.exec(branch)[1]);
  if (!positive(originalRunId))
    throw new Error("Invalid originating workflow run");
  const { data: origin } = await github.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: originalRunId,
  });
  if (
    Number(origin.id) !== originalRunId ||
    origin.path !== ".github/workflows/jarvis-autobuild.yml" ||
    origin.head_branch !== "main" ||
    origin.event !== "workflow_dispatch" ||
    origin.status !== "completed" ||
    origin.head_repository?.full_name !== `${owner}/${repo}`
  )
    throw new Error("Candidate originating workflow is not trusted");
  return { issue, pull, branch };
}
// Inspect Git objects before checkout: no candidate scripts, hooks, filters or npm.
// Worktree mode is used after the sandbox to check the cumulative final diff.
export function guardCumulative(base, head, worktree = false) {
  if (![base, head].every((s) => /^[0-9a-f]{40}$/.test(s)))
    throw new Error("Invalid guarded revision");
  const git = (...args) =>
    execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  const refs = worktree ? [base] : [base, head];
  const names = git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "--no-renames",
    "-z",
    ...refs,
    "--",
  )
    .split("\0")
    .filter(Boolean);
  const files = names.map((path) => {
    const [a, d] = git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "--no-renames",
      ...refs,
      "--",
      path,
    ).split("\t");
    let content = "",
      mode = "";
    if (worktree) {
      if (fs.existsSync(path)) {
        const stat = fs.lstatSync(path);
        mode = stat.isSymbolicLink()
          ? "120000"
          : stat.isFile()
            ? "100644"
            : "160000";
        if (stat.isFile()) content = fs.readFileSync(path);
      }
    } else {
      const entry = git("ls-tree", head, "--", path);
      mode = entry.slice(0, 6);
      if (mode === "100644" || mode === "100755")
        content = git("show", `${head}:${path}`);
    }
    if (
      /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/.test(String(content)) ||
      /(?:OPENAI_API_KEY|JARVIS_SERVICE_TOKEN|CONVEX_DEPLOY_KEY)\s*[:=]\s*\S+/.test(
        String(content),
      )
    )
      throw new Error("Cumulative candidate contains secret-like material");
    return {
      path,
      status: "M",
      additions: a === "-" ? 0 : Number(a || 0),
      deletions: d === "-" ? 0 : Number(d || 0),
      binary: a === "-" || d === "-",
      bytes: Buffer.byteLength(content),
      symlink: mode === "120000" || mode === "160000",
    };
  });
  const evaluation = evaluateDiff({ files });
  const patch = evaluatePatch(
    git("diff", "--no-ext-diff", "--no-textconv", "--unified=0", ...refs, "--"),
  );
  if (!evaluation.ok || !patch.ok)
    throw new Error(
      `Cumulative candidate guard rejected: ${[...evaluation.reasons, ...patch.reasons].join("; ")}`,
    );
}
