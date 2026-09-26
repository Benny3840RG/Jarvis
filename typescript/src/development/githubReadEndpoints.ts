/**
 * GitHub read-plane endpoint builders (roadmap PR F, auth/network hardening).
 *
 * The read plane may read exactly one repository. This module is the only place
 * a request URL path is constructed, and every path it builds is *fixed* to the
 * configured repository: callers pass a tool name and typed resource ids (a PR
 * number, an issue number, a commit SHA), never a raw path. A caller cannot
 * point the read plane at another repository, another owner, or a non-repo
 * endpoint — there is no code path that accepts a free-form path any more.
 *
 * Two boundaries are enforced here:
 *   1. Every allowlisted read tool maps to a builder, and each builder only
 *      emits `/repos/{owner}/{repo}/…` for the configured repository.
 *   2. `assertWithinRepository` re-checks the built path as defence in depth, so
 *      even a builder bug cannot emit a path outside the repository prefix.
 *
 * Resource ids are validated to safe shapes (positive integers; 7–40 char hex
 * commit SHAs), so an id cannot smuggle path traversal or a query string. Branch
 * or tag refs are intentionally not accepted yet — a SHA is unambiguous and
 * cannot contain a slash; ref support, if needed, is an additive change.
 */

import type { GitHubReadPlaneTool } from "./githubReadPlane.js";

/** The one repository the read plane is bound to. Non-secret configuration. */
export type GithubRepository = Readonly<{ owner: string; repo: string }>;

/** Typed parameters a read tool may take. Only known keys are read. */
export type GithubReadParams = Readonly<{
  pullNumber?: number;
  issueNumber?: number;
  ref?: string;
}>;

export class GithubReadEndpointError extends Error {
  constructor(message: string) {
    super(`GitHub read-plane endpoint error: ${message}`);
    this.name = "GithubReadEndpointError";
  }
}

// GitHub owner logins: alphanumeric and single hyphens, not leading/trailing.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
// Repository names: alphanumeric plus `.`, `_`, `-`.
const REPO_RE = /^[A-Za-z0-9._-]+$/;
// Commit SHA (abbreviated or full).
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/**
 * Parse `owner/repo` into a validated {@link GithubRepository}, fail-closed:
 * returns null unless there is exactly one `/`, both parts match GitHub's
 * charset, and the repo name is not `.`/`..`.
 */
export function parseGithubRepository(raw: string | undefined): GithubRepository | null {
  if (!raw) return null;
  const parts = raw.trim().split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0]!.trim();
  const repo = parts[1]!.trim();
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  if (repo === "." || repo === "..") return null;
  return Object.freeze({ owner, repo });
}

function repositoryPrefix(repository: GithubRepository): string {
  return `/repos/${repository.owner}/${repository.repo}`;
}

/**
 * Assert `path` stays within the configured repository — either the repository
 * root itself or a child of it. Defence in depth behind the builders.
 */
export function assertWithinRepository(path: string, repository: GithubRepository): void {
  const prefix = repositoryPrefix(repository);
  if (path !== prefix && !path.startsWith(`${prefix}/`)) {
    throw new GithubReadEndpointError("built path escapes the configured repository");
  }
}

function requirePositiveInt(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new GithubReadEndpointError(`${label} must be a positive integer`);
  }
  return value;
}

function requireSha(value: string | undefined): string {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new GithubReadEndpointError("ref must be a 7-40 character commit SHA");
  }
  return value;
}

type EndpointBuilder = (repository: GithubRepository, params: GithubReadParams) => string;

/**
 * One builder per allowlisted read tool. Every builder emits a path fixed to the
 * configured repository. Kept in lockstep with {@link GITHUB_READ_PLANE_TOOLS}
 * (a test asserts every tool has a builder and vice versa).
 */
const ENDPOINT_BUILDERS: Readonly<Record<GitHubReadPlaneTool, EndpointBuilder>> = {
  github_get_pull_request: (r, p) =>
    `${repositoryPrefix(r)}/pulls/${requirePositiveInt(p.pullNumber, "pullNumber")}`,
  github_list_pull_request_files: (r, p) =>
    `${repositoryPrefix(r)}/pulls/${requirePositiveInt(p.pullNumber, "pullNumber")}/files`,
  github_get_pull_request_status: (r, p) =>
    `${repositoryPrefix(r)}/commits/${requireSha(p.ref)}/status`,
  github_list_pull_request_comments: (r, p) =>
    `${repositoryPrefix(r)}/pulls/${requirePositiveInt(p.pullNumber, "pullNumber")}/comments`,
  github_get_issue: (r, p) =>
    `${repositoryPrefix(r)}/issues/${requirePositiveInt(p.issueNumber, "issueNumber")}`,
  github_list_issues: (r) => `${repositoryPrefix(r)}/issues`,
  github_get_commit: (r, p) => `${repositoryPrefix(r)}/commits/${requireSha(p.ref)}`,
  github_list_commits: (r) => `${repositoryPrefix(r)}/commits`,
  github_get_check_runs: (r, p) => `${repositoryPrefix(r)}/commits/${requireSha(p.ref)}/check-runs`,
};

/** The tools that have a repository-fixed builder. */
export const GITHUB_READ_ENDPOINT_TOOLS = Object.freeze(
  Object.keys(ENDPOINT_BUILDERS) as GitHubReadPlaneTool[],
);

/**
 * Build the repository-fixed API path for `tool` with `params`. Throws
 * {@link GithubReadEndpointError} for an unknown tool or invalid/missing params,
 * before any network call. The result is always within the configured repository.
 */
export function buildGithubReadPath(
  repository: GithubRepository,
  tool: GitHubReadPlaneTool,
  params: GithubReadParams = {},
): string {
  const builder = ENDPOINT_BUILDERS[tool];
  if (!builder) {
    throw new GithubReadEndpointError(`no endpoint builder for tool "${tool}"`);
  }
  const path = builder(repository, params);
  assertWithinRepository(path, repository);
  return path;
}
