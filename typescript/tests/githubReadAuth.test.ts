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

const config = {
  appId: "123",
  installationId: "456",
  privateKeyPem: PEM,
  repository: { owner: "Benny3840RG", repo: "Jarvis" },
} as const;

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

const tempDirs: string[] = [];
function credentialDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-gh-read-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A token response as GitHub returns it for a down-scoped mint. */
function scopedTokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      token: "ghs_installation_secret",
      expires_at: "2999-01-01T00:00:00Z",
      repository_selection: "selected",
      repositories: [{ name: "Jarvis" }],
      permissions: { metadata: "read", contents: "read", issues: "read", pull_requests: "read" },
      ...overrides,
    }),
    { status: 201 },
  );
}

describe("GitHub read-plane App auth (PR F, auth/network slice)", () => {
  it("resolves config from the systemd credential directory and a fixed repository", () => {
    const dir = credentialDir();
    writeFileSync(join(dir, "github-read-app.pem"), PEM, { mode: 0o600 });
    const resolved = resolveGithubAppReadConfigFromEnv({
      JARVIS_GITHUB_READ_APP_ID: "123",
      JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
      JARVIS_GITHUB_READ_REPOSITORY: "Benny3840RG/Jarvis",
      CREDENTIALS_DIRECTORY: dir,
      JARVIS_GITHUB_READ_PRIVATE_KEY_CREDENTIAL: "github-read-app.pem",
    });
    assert.equal(resolved?.privateKeyPem.includes("PRIVATE KEY"), true);
    assert.equal(resolved?.appId, "123");
    assert.deepEqual(resolved?.repository, { owner: "Benny3840RG", repo: "Jarvis" });
  });

  it("does NOT support an inline private key env var (systemd-credential only)", () => {
    // The old inline path is gone: an inline key alone resolves to null.
    assert.equal(
      resolveGithubAppReadConfigFromEnv({
        JARVIS_GITHUB_READ_APP_ID: "123",
        JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
        JARVIS_GITHUB_READ_REPOSITORY: "Benny3840RG/Jarvis",
        JARVIS_GITHUB_READ_PRIVATE_KEY: PEM,
      } as Record<string, string>),
      null,
    );
  });

  it("refuses a credential name that is not a bare file inside $CREDENTIALS_DIRECTORY", () => {
    const dir = credentialDir();
    writeFileSync(join(dir, "key.pem"), PEM, { mode: 0o600 });
    const base = {
      JARVIS_GITHUB_READ_APP_ID: "123",
      JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
      JARVIS_GITHUB_READ_REPOSITORY: "Benny3840RG/Jarvis",
      CREDENTIALS_DIRECTORY: dir,
    };
    // Path traversal / absolute path / nested path are all rejected.
    for (const name of ["../key.pem", "/etc/passwd", "sub/key.pem", "..", "."]) {
      assert.equal(
        resolveGithubAppReadConfigFromEnv({
          ...base,
          JARVIS_GITHUB_READ_PRIVATE_KEY_CREDENTIAL: name,
        }),
        null,
        name,
      );
    }
    // Missing $CREDENTIALS_DIRECTORY -> null even with a valid name.
    assert.equal(
      resolveGithubAppReadConfigFromEnv({
        ...base,
        CREDENTIALS_DIRECTORY: undefined,
        JARVIS_GITHUB_READ_PRIVATE_KEY_CREDENTIAL: "key.pem",
      }),
      null,
    );
  });

  it("fails closed when the app id, installation id, or repository is missing/invalid", () => {
    const dir = credentialDir();
    writeFileSync(join(dir, "key.pem"), PEM, { mode: 0o600 });
    const creds = {
      CREDENTIALS_DIRECTORY: dir,
      JARVIS_GITHUB_READ_PRIVATE_KEY_CREDENTIAL: "key.pem",
    };
    assert.equal(resolveGithubAppReadConfigFromEnv({}), null);
    assert.equal(
      resolveGithubAppReadConfigFromEnv({ JARVIS_GITHUB_READ_APP_ID: "123", ...creds }),
      null,
    );
    // Missing repository.
    assert.equal(
      resolveGithubAppReadConfigFromEnv({
        JARVIS_GITHUB_READ_APP_ID: "123",
        JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
        ...creds,
      }),
      null,
    );
    // Malformed repository (not owner/repo).
    assert.equal(
      resolveGithubAppReadConfigFromEnv({
        JARVIS_GITHUB_READ_APP_ID: "123",
        JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
        JARVIS_GITHUB_READ_REPOSITORY: "not-a-repo",
        ...creds,
      }),
      null,
    );
  });

  it("fails closed when the credential file is unreadable or not a key", () => {
    const dir = credentialDir();
    writeFileSync(join(dir, "notkey.txt"), "not-a-key", { mode: 0o600 });
    const base = {
      JARVIS_GITHUB_READ_APP_ID: "123",
      JARVIS_GITHUB_READ_INSTALLATION_ID: "456",
      JARVIS_GITHUB_READ_REPOSITORY: "Benny3840RG/Jarvis",
      CREDENTIALS_DIRECTORY: dir,
    };
    // Present but not a key.
    assert.equal(
      resolveGithubAppReadConfigFromEnv({
        ...base,
        JARVIS_GITHUB_READ_PRIVATE_KEY_CREDENTIAL: "notkey.txt",
      }),
      null,
    );
    // Missing file.
    assert.equal(
      resolveGithubAppReadConfigFromEnv({
        ...base,
        JARVIS_GITHUB_READ_PRIVATE_KEY_CREDENTIAL: "absent.pem",
      }),
      null,
    );
  });

  it("mints a down-scoped short-lived token via a well-formed RS256 App JWT on the approved origin", async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    let seenBody: unknown;
    const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get("authorization") ?? undefined;
      seenBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return scopedTokenResponse();
    }) as typeof globalThis.fetch;

    const token = await mintInstallationToken({
      config,
      fetch: fakeFetch,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    assert.equal(token.token, "ghs_installation_secret");
    assert.equal(token.expiresAt.toISOString(), "2999-01-01T00:00:00.000Z");
    assert.equal(seenUrl, "https://api.github.com/app/installations/456/access_tokens");

    // The mint request down-scopes the token: one repository, read-only perms.
    assert.deepEqual(seenBody, {
      repositories: ["Jarvis"],
      permissions: { metadata: "read", contents: "read", issues: "read", pull_requests: "read" },
    });

    // The Authorization bearer is a well-formed RS256 App JWT (iss = app id, <=10min TTL).
    assert.ok(seenAuth?.startsWith("Bearer "));
    const [header, payload] = seenAuth!.slice("Bearer ".length).split(".");
    assert.equal(decodeJwtPart(header!).alg, "RS256");
    const claims = decodeJwtPart(payload!);
    assert.equal(claims.iss, "123");
    assert.ok((claims.exp as number) - (claims.iat as number) <= 600);
  });

  it("refuses a token whose returned scope is broader than requested", async () => {
    const cases: Array<{ label: string; overrides: Record<string, unknown> }> = [
      { label: "all-repository selection", overrides: { repository_selection: "all" } },
      { label: "a different repository", overrides: { repositories: [{ name: "OtherRepo" }] } },
      {
        label: "a write permission",
        overrides: { permissions: { contents: "read", issues: "write" } },
      },
    ];
    for (const { label, overrides } of cases) {
      const fakeFetch = (async () => scopedTokenResponse(overrides)) as typeof globalThis.fetch;
      await assert.rejects(
        () => mintInstallationToken({ config, fetch: fakeFetch }),
        GithubReadAuthError,
        label,
      );
    }
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
