import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MicrosoftDelegatedAccessTokenSupplier,
  MicrosoftDelegatedOAuthError,
  resolveMicrosoftDelegatedOAuthConfig,
  type RefreshTokenStore,
} from "../src/auth/microsoftDelegatedOAuth.js";

class MemoryRefreshTokenStore implements RefreshTokenStore {
  readonly writes: string[] = [];

  constructor(private token: string) {}

  async read(): Promise<string> {
    return this.token;
  }

  async replace(token: string): Promise<void> {
    this.token = token;
    this.writes.push(token);
  }
}

describe("Microsoft delegated OAuth configuration", () => {
  it("is disabled by default and rejects partial or ambiguous activation", () => {
    assert.deepEqual(resolveMicrosoftDelegatedOAuthConfig({}), { enabled: false });
    assert.throws(
      () => resolveMicrosoftDelegatedOAuthConfig({ JARVIS_OUTLOOK_ENABLED: "yes" }),
      /JARVIS_OUTLOOK_ENABLED must be true or false/u,
    );
    assert.throws(
      () => resolveMicrosoftDelegatedOAuthConfig({ JARVIS_OUTLOOK_ENABLED: "true" }),
      /JARVIS_OUTLOOK_CLIENT_ID is required/u,
    );
  });

  it("locks personal-account OAuth to the approved delegated scopes", () => {
    assert.deepEqual(
      resolveMicrosoftDelegatedOAuthConfig({
        JARVIS_OUTLOOK_ENABLED: "true",
        JARVIS_OUTLOOK_CLIENT_ID: "client-id",
        JARVIS_OUTLOOK_MAILBOX: "thebeeztreez@outlook.com",
        JARVIS_OUTLOOK_REFRESH_TOKEN_FILE: "/run/secrets/jarvis-outlook-refresh-token",
      }),
      {
        enabled: true,
        clientId: "client-id",
        mailbox: "thebeeztreez@outlook.com",
        refreshTokenFile: "/run/secrets/jarvis-outlook-refresh-token",
        tokenEndpoint: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        scopes: ["offline_access", "Mail.ReadWrite", "Mail.Send"],
      },
    );
  });
});

describe("MicrosoftDelegatedAccessTokenSupplier", () => {
  it("refreshes once, rotates the refresh token before returning, and caches only the access token", async () => {
    const store = new MemoryRefreshTokenStore("refresh-token-1");
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let now = 1_000_000;
    const supplier = new MicrosoftDelegatedAccessTokenSupplier({
      clientId: "client-id",
      scopes: ["offline_access", "Mail.ReadWrite", "Mail.Send"],
      tokenEndpoint: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
      refreshTokenStore: store,
      now: () => now,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            token_type: "Bearer",
            access_token: "access-token-1",
            expires_in: 3600,
            refresh_token: "refresh-token-2",
            scope: "Mail.Send offline_access Mail.ReadWrite",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const signal = new AbortController().signal;
    assert.equal(await supplier.getAccessToken(signal), "access-token-1");
    assert.equal(await supplier.getAccessToken(signal), "access-token-1");
    assert.equal(requests.length, 1);
    assert.deepEqual(store.writes, ["refresh-token-2"]);
    assert.equal(requests[0].url, "https://login.microsoftonline.com/consumers/oauth2/v2.0/token");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.redirect, "error");
    const body = new URLSearchParams(String(requests[0].init.body));
    assert.equal(body.get("client_id"), "client-id");
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "refresh-token-1");
    assert.equal(body.get("scope"), "offline_access Mail.ReadWrite Mail.Send");

    now += 3_601_000;
    assert.equal(await supplier.getAccessToken(signal), "access-token-1");
    assert.equal(requests.length, 2);
  });

  it("deduplicates concurrent refreshes", async () => {
    const store = new MemoryRefreshTokenStore("refresh-token");
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const supplier = new MicrosoftDelegatedAccessTokenSupplier({
      clientId: "client-id",
      scopes: ["offline_access", "Mail.ReadWrite", "Mail.Send"],
      tokenEndpoint: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
      refreshTokenStore: store,
      fetch: async () => {
        requests += 1;
        await gate;
        return new Response(
          JSON.stringify({
            token_type: "Bearer",
            access_token: "access-token",
            expires_in: 3600,
            scope: "offline_access Mail.ReadWrite Mail.Send",
          }),
          { status: 200 },
        );
      },
    });

    const signal = new AbortController().signal;
    const first = supplier.getAccessToken(signal);
    const second = supplier.getAccessToken(signal);
    release();
    assert.deepEqual(await Promise.all([first, second]), ["access-token", "access-token"]);
    assert.equal(requests, 1);
  });

  it("fails with stable redacted errors and never replaces the refresh token on an invalid response", async () => {
    const secret = "extremely-secret-refresh-token";
    const store = new MemoryRefreshTokenStore(secret);
    const supplier = new MicrosoftDelegatedAccessTokenSupplier({
      clientId: "client-id",
      scopes: ["offline_access", "Mail.ReadWrite", "Mail.Send"],
      tokenEndpoint: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
      refreshTokenStore: store,
      fetch: async () => new Response(`diagnostic ${secret}`, { status: 401 }),
    });

    await assert.rejects(
      supplier.getAccessToken(new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof MicrosoftDelegatedOAuthError);
        assert.equal(error.code, "microsoft-oauth-refresh-rejected-401");
        assert.doesNotMatch(String(error), /extremely-secret|diagnostic/u);
        return true;
      },
    );
    assert.deepEqual(store.writes, []);
  });
});
