/**
 * GitHub MCP read plane — the safety contract (roadmap PR F).
 *
 * The acquisition plan brings in GitHub access as an *acquired* capability that
 * must sit underneath Jarvis authority: Jarvis may *read* GitHub (pull
 * requests, issues, commits, checks) but the read plane must never expose a
 * write, merge, or approval tool. Merging and approving stay owner-only through
 * the governed boundary (AUTH-INV-01); acquiring GitHub reads must not open a
 * side door around that.
 *
 * This module is the contract that freezes that boundary before any live GitHub
 * wiring exists (contract-first, like the authority and telemetry contracts):
 *
 *   - `GITHUB_READ_PLANE_TOOLS` is the allowlist of tools the read plane may
 *     expose, and every entry is a read.
 *   - `isGitHubReadOnlyTool` / `assertGitHubReadOnly` classify a tool name
 *     fail-closed: a name is read-only only if it *starts* with a read verb and
 *     carries no mutation/authority token anywhere. Anything unrecognised is
 *     treated as a write and refused.
 *
 * When the live GitHub MCP wiring lands, it must expose only
 * `GITHUB_READ_PLANE_TOOLS` and route every candidate tool name through
 * `assertGitHubReadOnly`, so "merge and write tools do not exist" on this plane
 * is enforced, not assumed. `tests/githubReadPlane.test.ts` holds the contract.
 */

/** Verbs that denote a read. A read-plane tool name must start with one. */
const READ_VERBS: ReadonlySet<string> = new Set(["get", "list", "search", "read"]);

/**
 * Verbs that mutate GitHub state or exercise authority. None may appear in a
 * read-plane tool name. Kept broad and fail-closed on purpose: the plane is an
 * allowlist of reads, so over-rejecting a fringe name is safe, under-rejecting
 * a write is not.
 */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  "merge",
  "create",
  "update",
  "delete",
  "write",
  "approve",
  "reject",
  "close",
  "reopen",
  "dispatch",
  "push",
  "revoke",
  "execute",
  "comment",
  "review",
  "assign",
  "lock",
  "unlock",
  "transfer",
  "rename",
  "edit",
  "add",
  "remove",
  "set",
  "enable",
  "disable",
  "submit",
  "upload",
  "fork",
  "star",
  "subscribe",
  // "request" is intentionally NOT listed: it is a noun token in
  // "pull_request", and a genuine write like "request_review" is already
  // rejected because "request" is not a read verb (fails the first-token check)
  // and "review" is a forbidden token.
]);

/** The tools the GitHub read plane may expose. Every entry must be read-only. */
export const GITHUB_READ_PLANE_TOOLS = [
  "github_get_pull_request",
  "github_list_pull_request_files",
  "github_get_pull_request_status",
  "github_list_pull_request_comments",
  "github_get_issue",
  "github_list_issues",
  "github_get_commit",
  "github_list_commits",
  "github_get_check_runs",
] as const;

export type GitHubReadPlaneTool = (typeof GITHUB_READ_PLANE_TOOLS)[number];

/**
 * Whether `name` is a read-only GitHub tool: it must start with a read verb
 * (after an optional `github` namespace token) and contain no mutation or
 * authority token anywhere. Fail-closed — an empty or unrecognised name is not
 * read-only.
 */
export function isGitHubReadOnlyTool(name: string): boolean {
  const tokens = name
    .toLowerCase()
    .split(/[_:./-]+/)
    .filter(Boolean);
  const rest = tokens[0] === "github" ? tokens.slice(1) : tokens;
  const verb = rest[0];
  if (verb === undefined || !READ_VERBS.has(verb)) return false;
  return !rest.some((token) => WRITE_VERBS.has(token));
}

export class GitHubWriteForbiddenError extends Error {
  constructor(name: string) {
    super(`GitHub tool "${name}" is not read-only; the GitHub MCP plane exposes reads only.`);
    this.name = "GitHubWriteForbiddenError";
  }
}

/** Refuse any tool name that is not a read. The single gate live wiring must call. */
export function assertGitHubReadOnly(name: string): void {
  if (!isGitHubReadOnlyTool(name)) throw new GitHubWriteForbiddenError(name);
}
