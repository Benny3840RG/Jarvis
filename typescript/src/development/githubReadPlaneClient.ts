/**
 * GitHub read-plane client (roadmap PR F, auth/network slice).
 *
 * The single object through which Jarvis reads GitHub. It binds the three F
 * boundaries together so none can be bypassed:
 *
 *   1. Tool surface — every request names a tool that must be on
 *      {@link GITHUB_READ_PLANE_TOOLS} *and* pass {@link assertGitHubReadOnly}.
 *      A write/merge/approve name, or any name not on the allowlist, is refused
 *      before a token is minted or a request is dispatched (fail-closed).
 *   2. Egress — the target resolves against the hard-coded API origin and goes
 *      out through {@link guardedGitHubFetch}; an absolute off-origin path is
 *      refused, again before any token is minted.
 *   3. Auth — a short-lived installation token (dedicated read-only App) is
 *      minted at runtime, cached in memory for its lifetime only, and never
 *      persisted. It is never logged; rest errors carry only the HTTP status.
 *
 * This client exposes reads only — it has, by construction and by test
 * (`tests/githubReadPlaneSurface.test.ts`), no write, merge, or approve method.
 * Typed per-endpoint helpers can be layered on `read()` later; the boundary is
 * what this slice freezes.
 */

import {
  assertGitHubReadOnly,
  GITHUB_READ_PLANE_TOOLS,
  GitHubWriteForbiddenError,
} from "./githubReadPlane.js";
import { GITHUB_API_ORIGIN, assertGitHubApiUrl, guardedGitHubFetch } from "./githubReadEgress.js";
import {
  mintInstallationToken,
  type GithubAppReadConfig,
  type InstallationToken,
} from "./githubReadAuth.js";

export type GithubReadRequest = Readonly<{ tool: string; path: string }>;

export type GithubReadPlaneClientDeps = Readonly<{
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  mint?: (input: {
    config: GithubAppReadConfig;
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
  }) => Promise<InstallationToken>;
}>;

export class GitHubReadRestError extends Error {
  constructor(
    readonly status: number,
    readonly requestId: string | undefined,
  ) {
    super(`GitHub read-plane request failed with status ${status}.`);
    this.name = "GitHubReadRestError";
  }
}

// Re-mint a little before expiry so an in-flight request never rides a token
// that lapses mid-call.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export class GithubReadPlaneClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly mint: NonNullable<GithubReadPlaneClientDeps["mint"]>;
  private cachedToken: InstallationToken | undefined;

  constructor(
    private readonly config: GithubAppReadConfig,
    deps: GithubReadPlaneClientDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? (() => new Date());
    this.mint = deps.mint ?? mintInstallationToken;
  }

  private assertReadPlaneTool(tool: string): void {
    // Fail-closed: must be a declared read-plane tool AND classify as read-only.
    if (!(GITHUB_READ_PLANE_TOOLS as readonly string[]).includes(tool)) {
      throw new GitHubWriteForbiddenError(tool);
    }
    assertGitHubReadOnly(tool);
  }

  private async token(): Promise<string> {
    const current = this.cachedToken;
    if (current && current.expiresAt.getTime() - this.now().getTime() > TOKEN_REFRESH_MARGIN_MS) {
      return current.token;
    }
    const minted = await this.mint({ config: this.config, fetch: this.fetchImpl, now: this.now });
    this.cachedToken = minted;
    return minted.token;
  }

  /**
   * Read one GitHub resource. `tool` must be an allowlisted read-plane tool and
   * `path` must resolve to the approved API origin. Both are checked before any
   * token is minted or request dispatched. Returns the parsed JSON body.
   */
  async read(request: GithubReadRequest): Promise<unknown> {
    this.assertReadPlaneTool(request.tool);
    // Resolve the path against the API origin; an absolute off-origin URL keeps
    // its own host and is refused by the egress assertion here — before auth.
    const target = assertGitHubApiUrl(new URL(request.path, GITHUB_API_ORIGIN).toString());

    const token = await this.token();
    const response = await guardedGitHubFetch(this.fetchImpl, target.toString(), {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jarvis-github-read-plane",
      },
    });
    if (!response.ok) {
      throw new GitHubReadRestError(
        response.status,
        response.headers.get("x-github-request-id") ?? undefined,
      );
    }
    if (response.status === 204) return null;
    return response.json();
  }
}
