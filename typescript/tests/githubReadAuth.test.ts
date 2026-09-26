import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  GithubReadAuthError,
  mintInstallationToken,
  resolveGithubAppReadConfigFromEnv,
} from "../src/development/githubReadAuth.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const config = { appId: "123", installationId: "456", privateKeyPem: PEM } as const;

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GitHub read-plane App auth (PR F, auth/network slice)", () => {
  it("resolves config from an inline private key", () => {
    const resolved = resolveGithubAppReadConfigFromEnv({
      JARVIS_GITHUB_READ_APP_ID: "123",
      JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
      JARVIS_GITHUB_READ_PRIVATE_KEY: PEM,
    });
    // Inline env values are trimmed for hygiene; the key body is preserved.
    assert.deepEqual(resolved, { ...config, privateKeyPem: PEM.trim() });
  });

  it("resolves config from a host credential file (systemd LoadCredential path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-gh-read-"));
    tempDirs.push(dir);
    const keyPath = join(dir, "github-read-app.pem");
    writeFileSync(keyPath, PEM, { mode: 0o600 });
    const resolved = resolveGithubAppReadConfigFromEnv({
      JARVIS_GITHUB_READ_APP_ID: "123",
      JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
      JARVIS_GITHUB_READ_PRIVATE_KEY_FILE: keyPath,
    });
    assert.equal(resolved?.privateKeyPem.includes("PRIVATE KEY"), true);
    assert.equal(resolved?.appId, "123");
  });

  it("fails closed when any credential is missing or malformed", () => {
    // Missing app id / installation id / key -> null (no client is constructed).
    assert.equal(resolveGithubAppReadConfigFromEnv({}), null);
    assert.equal(resolveGithubAppReadConfigFromEnv({ JARVIS_GITHUB_READ_APP_ID: "123" }), null);
    assert.equal(
      resolveGithubAppReadConfigFromEnv({
        JARVIS_GITHUB_READ_APP_ID: "123",
        JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
      }),
      null,
    );
    // Present but not a private key.
    assert.equal(
      resolveGithubAppReadConfigFromEnv({
        JARVIS_GITHUB_READ_APP_ID: "123",
        JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
        JARVIS_GITHUB_READ_PRIVATE_KEY: "not-a-key",
      }),
      null,
    );
    // Unreadable key file.
    assert.equal(
      resolveGithubAppReadConfigFromEnv({
        JARVIS_GITHUB_READ_APP_ID: "123",
        JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
        JARVIS_GITHUB_READ_PRIVATE_KEY_FILE: "/nonexistent/does-not-exist.pem",
      }),
      null,
    );
  });

  it("mints a short-lived installation token via a well-formed RS256 App JWT on the approved origin", async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response(
        JSON.stringify({ token: "ghs_installation_secret", expires_at: "2999-01-01T00:00:00Z" }),
        {
          status: 201,
        },
      );
    }) as typeof globalThis.fetch;

    const token = await mintInstallationToken({
      config,
      fetch: fakeFetch,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    assert.equal(token.token, "ghs_installation_secret");
    assert.equal(token.expiresAt.toISOString(), "2999-01-01T00:00:00.000Z");
    assert.equal(seenUrl, "https://api.github.com/app/installations/456/access_tokens");

    // The Authorization bearer is a well-formed RS256 App JWT (iss = app id, <=10min TTL).
    assert.ok(seenAuth?.startsWith("Bearer "));
    const [header, payload] = seenAuth!.slice("Bearer ".length).split(".");
    assert.equal(decodeJwtPart(header!).alg, "RS256");
    const claims = decodeJwtPart(payload!);
    assert.equal(claims.iss, "123");
    assert.ok((claims.exp as number) - (claims.iat as number) <= 600);
  });

  it("throws a redacted error on a failed token request — never the key or token", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
      })) as typeof globalThis.fetch;

    await assert.rejects(
      () => mintInstallationToken({ config, fetch: fakeFetch }),
      (error: unknown) => {
        assert.ok(error instanceof GithubReadAuthError);
        assert.match(error.message, /401/);
        assert.doesNotMatch(error.message, /PRIVATE KEY/);
        assert.doesNotMatch(error.message, /ghs_/);
        return true;
      },
    );
  });

  it("rejects a malformed token response", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ nope: true }), { status: 201 })) as typeof globalThis.fetch;
    await assert.rejects(
      () => mintInstallationToken({ config, fetch: fakeFetch }),
      GithubReadAuthError,
    );
  });
});
