/**
 * GitHub read-plane egress boundary (roadmap PR F, auth/network slice).
 *
 * The acquired GitHub read plane may talk to exactly one host over exactly one
 * transport: HTTPS to `api.github.com`. This module hard-codes that origin and
 * refuses everything else — other hosts (raw-content, uploads, codeload, the
 * web host), other schemes (git, ws, ftp, plain http), non-standard ports,
 * embedded credentials, and cross-host redirects. Deny-by-default: a URL is
 * allowed only if it resolves to the one approved origin.
 *
 * This is the code half of the operator's network decision. The environment's
 * own egress policy still permits only `api.github.com:443`; this guard makes
 * the same boundary true in-process, so a bug or a crafted path cannot reach
 * off-origin even if the network policy were relaxed. `guardedGitHubFetch` is
 * the single chokepoint every read-plane request must pass through.
 */

/** The one and only origin the read plane may reach. Hard-coded on purpose. */
export const GITHUB_API_ORIGIN = "https://api.github.com";

export class GitHubEgressForbiddenError extends Error {
  constructor(reason: string) {
    super(`GitHub read-plane egress refused: ${reason}`);
    this.name = "GitHubEgressForbiddenError";
  }
}

/**
 * Parse `rawUrl` and return it only if it resolves to {@link GITHUB_API_ORIGIN}
 * over HTTPS with no embedded credentials. Throws {@link GitHubEgressForbiddenError}
 * otherwise. Fail-closed: an unparseable URL is refused.
 */
export function assertGitHubApiUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GitHubEgressForbiddenError("URL is not parseable");
  }
  if (url.protocol !== "https:") {
    throw new GitHubEgressForbiddenError(`scheme "${url.protocol}" is not https`);
  }
  if (url.username || url.password) {
    throw new GitHubEgressForbiddenError("URL carries embedded credentials");
  }
  // `origin` normalises the default :443 away and folds host+port+scheme into
  // one comparison, so a look-alike host or a non-standard port cannot match.
  if (url.origin !== GITHUB_API_ORIGIN) {
    throw new GitHubEgressForbiddenError(`origin "${url.origin}" is not the approved API origin`);
  }
  return url;
}

/**
 * Fetch through the egress boundary: the request URL must be on the approved
 * origin, redirect following is forced to `error` (a redirect off-origin can
 * never be followed), and the returned response URL is re-checked as defence in
 * depth. Any escape throws {@link GitHubEgressForbiddenError} before or instead
 * of returning a response.
 */
export async function guardedGitHubFetch(
  fetchImpl: typeof globalThis.fetch,
  rawUrl: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = assertGitHubApiUrl(rawUrl);
  if (init.redirect !== undefined && init.redirect !== "error") {
    throw new GitHubEgressForbiddenError(
      'redirect handling must be "error"; cross-host redirects are not allowed',
    );
  }
  const response = await fetchImpl(url, { ...init, redirect: "error" });
  // If the implementation ignored `redirect: "error"` and followed one, the
  // response URL would point off-origin. Re-assert it (empty url = same origin).
  if (response.url) {
    try {
      assertGitHubApiUrl(response.url);
    } catch {
      throw new GitHubEgressForbiddenError("response escaped the approved origin");
    }
  }
  return response;
}
