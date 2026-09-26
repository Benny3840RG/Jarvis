/**
 * GitHub read-plane App authentication (roadmap PR F, auth/network slice).
 *
 * The acquired read plane authenticates as a *dedicated read-only GitHub App*
 * — not the governed merge token (`JARVIS_GITHUB_TOKEN`), which carries
 * owner-only authority and must never be reused here. Per the owner's decision
 * the App's private key lives *only* in host-controlled systemd credential
 * storage: `LoadCredential=<name>:<source>` exposes it as a file named `<name>`
 * under `$CREDENTIALS_DIRECTORY`. This module reads it from that directory and
 * nowhere else — there is no inline-key env var and no arbitrary file path.
 *
 * The token minted from that key is explicitly *down-scoped* to the one
 * configured repository with read-only permissions, and the minted token's
 * returned scope is validated before use (fail-closed): a token that came back
 * with a broader repository selection or any non-read permission is refused, so
 * the read plane never rides a token wider than the read it needs. The private
 * key and token never appear in any error, log line, or return value beyond the
 * token string itself.
 *
 * Provisioning (Benny, outside the repo): create the App installed only on the
 * one repository with read-only Metadata/Contents/PullRequests/Issues and NO
 * write permission; expose its private key via systemd `LoadCredential`; set
 * `JARVIS_GITHUB_READ_APP_ID`, `JARVIS_GITHUB_READ_INSTALLATION_ID`,
 * `JARVIS_GITHUB_READ_PRIVATE_KEY_CREDENTIAL` (the credential name under
 * `$CREDENTIALS_DIRECTORY`), and `JARVIS_GITHUB_READ_REPOSITORY` (`owner/repo`).
 * Until all are present and valid, {@link resolveGithubAppReadConfigFromEnv}
 * returns null and no read client is constructed (fail-closed).
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GITHUB_API_ORIGIN, guardedGitHubFetch } from "./githubReadEgress.js";
import { parseGithubRepository, type GithubRepository } from "./githubReadEndpoints.js";

/** The read-only permissions the down-scoped installation token requests. */
export const GITHUB_READ_TOKEN_PERMISSIONS = Object.freeze({
  metadata: "read",
  contents: "read",
  issues: "read",
  pull_requests: "read",
} as const);

/** Resolved credentials for the dedicated read-only GitHub App. */
export type GithubAppReadConfig = Readonly<{
  appId: string;
  installationId: string;
  privateKeyPem: string;
  repository: GithubRepository;
}>;

/** A minted installation token. Held in memory only; never persisted. */
export type InstallationToken = Readonly<{ token: string; expiresAt: Date }>;

type Environment = Readonly<Record<string, string | undefined>>;

/** A credential name must be a bare file name inside `$CREDENTIALS_DIRECTORY`. */
function isSafeCredentialName(name: string): boolean {
  return (
    name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".."
  );
}

/**
 * Resolve the read App's credentials from the environment, fail-closed: returns
 * null unless the App id, installation id, a fixed `owner/repo`, and a private
 * key read from systemd credential storage are all present and valid. The key
 * is read only from `$CREDENTIALS_DIRECTORY/<name>`; there is no inline key and
 * no arbitrary path.
 */
export function resolveGithubAppReadConfigFromEnv(
  environment: Environment = process.env,
): GithubAppReadConfig | null {
  const appId = environment.JARVIS_GITHUB_READ_APP_ID?.trim();
  const installationId = environment.JARVIS_GITHUB_READ_INSTALLATION_ID?.trim();
  if (!appId || !installationId) return null;

  const repository = parseGithubRepository(environment.JARVIS_GITHUB_READ_REPOSITORY);
  if (!repository) return null;

  // Key comes only from systemd credential storage: a bare credential name
  // resolved against $CREDENTIALS_DIRECTORY. No inline key, no arbitrary path.
  const credentialsDir = environment.CREDENTIALS_DIRECTORY?.trim();
  const credentialName = environment.JARVIS_GITHUB_READ_PRIVATE_KEY_CREDENTIAL?.trim();
  if (!credentialsDir || !credentialName || !isSafeCredentialName(credentialName)) return null;

  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(join(credentialsDir, credentialName), "utf8");
  } catch {
    return null;
  }
  if (!privateKeyPem.includes("PRIVATE KEY")) return null;

  return { appId, installationId, privateKeyPem, repository };
}

export class GithubReadAuthError extends Error {
  constructor(message: string) {
    super(`GitHub read-plane auth failed: ${message}`);
    this.name = "GithubReadAuthError";
  }
}

function base64url(value: string | Buffer): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");
}

/**
 * Build a short-lived RS256 App JWT (issuer = App id, TTL well under GitHub's
 * 10-minute maximum, backdated 60s for clock skew). Signing failures are
 * reported without ever echoing the key.
 */
function appJwt(config: GithubAppReadConfig, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const signingInput = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: config.appId }),
  )}`;
  let signature: Buffer;
  try {
    signature = createSign("RSA-SHA256").update(signingInput).sign(config.privateKeyPem);
  } catch {
    throw new GithubReadAuthError("could not sign the App JWT with the configured private key");
  }
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Validate that the minted token's returned scope is no broader than requested,
 * fail-closed:
 *
 *   - `repository_selection` must be present and exactly `selected` (never `all`).
 *     This alone proves the token is not installation-wide; the token was minted
 *     from this module's request scoped to the one configured repository, so a
 *     `selected` token cannot cover a repository we did not request.
 *   - `repositories`, *when the response includes it*, must be a non-empty array
 *     in which every entry's `full_name` matches the configured `owner/repo`
 *     exactly (case-insensitive) — the owner is checked, not just the repo name,
 *     so a same-named repo under another owner is refused. GitHub does not
 *     guarantee this list on the token response, so its absence is not itself a
 *     failure (requiring it would reject otherwise-valid down-scoped tokens); a
 *     present-but-empty or mismatched list is.
 *   - `permissions` must be present, and every key must be one this module
 *     requested ({@link GITHUB_READ_TOKEN_PERMISSIONS}) with the value `read`.
 *     An unrequested key — even at `read` — is refused.
 *
 * A response that omits `repository_selection` or `permissions` proves nothing
 * about the token's scope and is refused. Throws a redacted
 * {@link GithubReadAuthError} otherwise.
 */
function assertTokenScope(
  body: { repository_selection?: unknown; repositories?: unknown; permissions?: unknown },
  repository: GithubRepository,
): void {
  if (body.repository_selection !== "selected") {
    throw new GithubReadAuthError("installation token was not scoped to a selected repository");
  }
  // Validate the repository list when GitHub returns one; do not require it
  // (the token response does not guarantee it, and `selected` already rules out
  // an installation-wide token minted from our single-repository request).
  if (body.repositories !== undefined) {
    if (!Array.isArray(body.repositories) || body.repositories.length === 0) {
      throw new GithubReadAuthError("installation token repositories were malformed");
    }
    const wanted = `${repository.owner}/${repository.repo}`.toLowerCase();
    for (const entry of body.repositories) {
      const fullName = (entry as { full_name?: unknown })?.full_name;
      if (typeof fullName !== "string" || fullName.toLowerCase() !== wanted) {
        throw new GithubReadAuthError(
          "installation token was scoped beyond the configured repository",
        );
      }
    }
  }
  if (typeof body.permissions !== "object" || body.permissions === null) {
    throw new GithubReadAuthError("installation token permissions were missing or malformed");
  }
  const requested = new Set<string>(Object.keys(GITHUB_READ_TOKEN_PERMISSIONS));
  for (const [key, level] of Object.entries(body.permissions as Record<string, unknown>)) {
    if (!requested.has(key)) {
      throw new GithubReadAuthError("installation token carried an unrequested permission");
    }
    if (level !== "read") {
      throw new GithubReadAuthError("installation token carried a non-read permission");
    }
  }
}

/**
 * Mint a short-lived installation access token via the App JWT, over the egress
 * boundary (api.github.com only), explicitly down-scoped to the configured
 * repository with read-only permissions. The token is returned and never logged
 * or persisted; on failure a redacted {@link GithubReadAuthError} carries only
 * the HTTP status, never the JWT, key, or any returned token.
 */
export async function mintInstallationToken(input: {
  config: GithubAppReadConfig;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}): Promise<InstallationToken> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const now = input.now?.() ?? new Date();
  const jwt = appJwt(input.config, now);

  const response = await guardedGitHubFetch(
    fetchImpl,
    `${GITHUB_API_ORIGIN}/app/installations/${encodeURIComponent(input.config.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jarvis-github-read-plane",
      },
      // Down-scope the token: one repository, read-only permissions.
      body: JSON.stringify({
        repositories: [input.config.repository.repo],
        permissions: GITHUB_READ_TOKEN_PERMISSIONS,
      }),
    },
  );
  if (!response.ok) {
    throw new GithubReadAuthError(`installation token request returned status ${response.status}`);
  }

  let body: {
    token?: unknown;
    expires_at?: unknown;
    repository_selection?: unknown;
    repositories?: unknown;
    permissions?: unknown;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new GithubReadAuthError("installation token response was not valid JSON");
  }
  if (typeof body.token !== "string" || !body.token.trim() || typeof body.expires_at !== "string") {
    throw new GithubReadAuthError("installation token response was malformed");
  }
  assertTokenScope(body, input.config.repository);
  const expiresAt = new Date(body.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new GithubReadAuthError("installation token expiry was not a valid date");
  }
  return Object.freeze({ token: body.token, expiresAt });
}
