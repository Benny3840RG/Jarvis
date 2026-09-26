/**
 * GitHub read-plane App authentication (roadmap PR F, auth/network slice).
 *
 * The acquired read plane authenticates as a *dedicated read-only GitHub App*
 * — not the governed merge token (`JARVIS_GITHUB_TOKEN`), which carries
 * owner-only authority and must never be reused here. The App's private key
 * lives in host-controlled credential storage (systemd `LoadCredential` exposes
 * it as a file under `$CREDENTIALS_DIRECTORY`); this module reads it from that
 * path, mints a short-lived installation access token at runtime, and never
 * persists the token. The private key and the token never appear in any error,
 * log line, or return value beyond the token itself.
 *
 * Provisioning (Benny, outside the repo): create the App installed only on
 * `Benny3840/Jarvis` with read-only Metadata/Contents/PullRequests/Issues and
 * NO write permission; place its private key in systemd credential storage; set
 * `JARVIS_GITHUB_READ_APP_ID`, `JARVIS_GITHUB_READ_INSTALLATION_ID`, and
 * `JARVIS_GITHUB_READ_PRIVATE_KEY_FILE` (or `_PRIVATE_KEY` inline) in the env.
 * Until all are present, {@link resolveGithubAppReadConfigFromEnv} returns null
 * and no read client is constructed (fail-closed).
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import { GITHUB_API_ORIGIN, guardedGitHubFetch } from "./githubReadEgress.js";

/** Resolved credentials for the dedicated read-only GitHub App. */
export type GithubAppReadConfig = Readonly<{
  appId: string;
  installationId: string;
  privateKeyPem: string;
}>;

/** A minted installation token. Held in memory only; never persisted. */
export type InstallationToken = Readonly<{ token: string; expiresAt: Date }>;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the read App's credentials from the environment, fail-closed: returns
 * null unless the App id, installation id, and a private key (inline PEM or a
 * readable credential file) are all present and the key looks like a PEM.
 */
export function resolveGithubAppReadConfigFromEnv(
  environment: Environment = process.env,
): GithubAppReadConfig | null {
  const appId = environment.JARVIS_GITHUB_READ_APP_ID?.trim();
  const installationId = environment.JARVIS_GITHUB_READ_INSTALLATION_ID?.trim();
  if (!appId || !installationId) return null;

  const keyFile = environment.JARVIS_GITHUB_READ_PRIVATE_KEY_FILE?.trim();
  const inlineKey = environment.JARVIS_GITHUB_READ_PRIVATE_KEY?.trim();
  let privateKeyPem: string | undefined;
  if (keyFile) {
    try {
      privateKeyPem = readFileSync(keyFile, "utf8");
    } catch {
      // A configured-but-unreadable key must not silently fall back to inline.
      return null;
    }
  } else if (inlineKey) {
    privateKeyPem = inlineKey;
  }
  if (!privateKeyPem?.includes("PRIVATE KEY")) return null;

  return { appId, installationId, privateKeyPem };
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
 * Mint a short-lived installation access token via the App JWT, over the egress
 * boundary (api.github.com only). The token is returned and never logged or
 * persisted; on failure a redacted {@link GithubReadAuthError} carries only the
 * HTTP status, never the JWT, key, or any returned token.
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
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jarvis-github-read-plane",
      },
    },
  );
  if (!response.ok) {
    throw new GithubReadAuthError(`installation token request returned status ${response.status}`);
  }

  let body: { token?: unknown; expires_at?: unknown };
  try {
    body = (await response.json()) as { token?: unknown; expires_at?: unknown };
  } catch {
    throw new GithubReadAuthError("installation token response was not valid JSON");
  }
  if (typeof body.token !== "string" || !body.token.trim() || typeof body.expires_at !== "string") {
    throw new GithubReadAuthError("installation token response was malformed");
  }
  const expiresAt = new Date(body.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new GithubReadAuthError("installation token expiry was not a valid date");
  }
  return Object.freeze({ token: body.token, expiresAt });
}
