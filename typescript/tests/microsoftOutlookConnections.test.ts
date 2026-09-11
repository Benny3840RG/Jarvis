import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createMicrosoftOutlookRuntimeFromEnv } from "../src/auth/microsoftOutlookRuntime.js";
import { resolveOutlookConnections } from "../src/auth/microsoftOutlookConnections.js";
import { MicrosoftDelegatedAccessTokenSupplier } from "../src/auth/microsoftDelegatedOAuth.js";
import type { QuoteEmailPrepareInput } from "../src/quotes/quoteEmailProvider.js";

const tenantId = "11111111-2222-3333-4444-555555555555";
const personal = {
  id: "personal",
  clientId: "aaaaaaaa-2222-3333-4444-555555555555",
  mailbox: "personal@outlook.com",
  refreshTokenFile: "/private/personal.token",
};
const business = {
  id: "business",
  clientId: "bbbbbbbb-2222-3333-4444-555555555555",
  mailbox: "business@example.com",
  tenantId,
  refreshTokenFile: "/private/business.token",
};
const environment = (connections: unknown[] = [personal, business]) => ({
  JARVIS_OUTLOOK_ENABLED: "true",
  JARVIS_OUTLOOK_CONNECTIONS_JSON: JSON.stringify(connections),
});
const signal = new AbortController().signal;
const bytes = Buffer.from("%PDF-test");
function input(senderConnection: string): QuoteEmailPrepareInput {
  return {
    quoteId: "quote-1",
    revision: {
      quoteId: "quote-1",
      status: "finalized",
      fingerprint: "fp",
    } as QuoteEmailPrepareInput["revision"],
    recipient: "test@example.com",
    subject: "Quote",
    body: "Attached",
    senderConnection,
    attachment: {
      filename: "quote.pdf",
      mediaType: "application/pdf",
      bytes,
      digest: `quote-pdf:v1:sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    },
  };
}

function fixture(connections = [personal, business]) {
  const requests: { url: string; auth: string | null; body: string }[] = [];
  const tokens = new Map<string, string>();
  const rotations: string[] = [];
  const runtime = createMicrosoftOutlookRuntimeFromEnv(environment(connections), {
    createRefreshTokenStore: (config) => ({
      async read() {
        return tokens.get(config.refreshTokenFile) ?? config.clientId;
      },
      async replace(token) {
        tokens.set(config.refreshTokenFile, token);
        rotations.push(config.refreshTokenFile);
      },
    }),
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        auth: new Headers(init?.headers).get("Authorization"),
        body: String(init?.body ?? ""),
      });
      if (String(url).endsWith("/token")) {
        const form = new URLSearchParams(String(init?.body));
        return new Response(
          JSON.stringify({
            token_type: "Bearer",
            access_token: form.get("client_id"),
            refresh_token: `rotated-${form.get("client_id")}`,
            expires_in: 3600,
            scope:
              "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send",
          }),
        );
      }
      if (String(url).endsWith("/send")) return new Response(null, { status: 202 });
      if (init?.method === "GET")
        return new Response(
          JSON.stringify({
            id: "same-message-id",
            isDraft: false,
            sentDateTime: "2026-09-09T00:00:00Z",
          }),
        );
      return new Response(JSON.stringify({ id: "same-message-id", isDraft: true }), {
        status: 201,
      });
    },
  });
  assert.ok(runtime);
  return { runtime, requests, rotations };
}

describe("isolated Outlook connections", () => {
  it("requires unique registrations, mailboxes and token files, with a pinned business tenant", () => {
    const configs = resolveOutlookConnections(environment());
    assert.equal(configs.length, 2);
    assert.match(configs[1].config.tokenEndpoint, new RegExp(tenantId));
    for (const override of [
      { clientId: personal.clientId },
      { mailbox: personal.mailbox },
      { refreshTokenFile: "/private/./personal.token" },
      { tenantId: "common" },
      { id: "personal" },
    ]) {
      assert.throws(() =>
        resolveOutlookConnections(environment([personal, { ...business, ...override }])),
      );
    }
    assert.throws(() =>
      resolveOutlookConnections({ ...environment(), JARVIS_OUTLOOK_CLIENT_ID: "legacy" }),
    );
    assert.throws(() =>
      resolveOutlookConnections(environment([{ ...personal, unexpected: "secret" }])),
    );
    assert.throws(() => resolveOutlookConnections(environment([])));
  });

  it("binds connection selection to configuration, including a change of tenant or mailbox", () => {
    const original = resolveOutlookConnections(environment())[1].senderConnection;
    const changed = resolveOutlookConnections(
      environment([personal, { ...business, mailbox: "other@example.com" }]),
    )[1].senderConnection;
    assert.notEqual(original, changed);
    const { runtime, requests } = fixture();
    assert.throws(() => runtime.quoteEmailProvider.validateSender?.(undefined), /sender/u);
    assert.throws(() => runtime.quoteEmailProvider.validateSender?.(changed), /sender/u);
    assert.equal(requests.length, 0);
  });

  it("keeps token caches, rotations and identical message IDs separate across restart and reordered config", async () => {
    const { runtime, requests, rotations } = fixture();
    const configs = resolveOutlookConnections(environment());
    const refs = await Promise.all(
      configs.map((c) => runtime.quoteEmailProvider.prepare(input(c.senderConnection), signal)),
    );
    assert.notEqual(refs[0].providerRequestId, refs[1].providerRequestId);
    for (const ref of refs) {
      await runtime.quoteEmailProvider.sendPrepared(ref, signal);
      assert.equal(
        (
          await runtime.reconciliationAdapter.reconcile(
            { ...ref, provider: runtime.quoteEmailProvider.name },
            signal,
          )
        ).status,
        "succeeded",
      );
    }
    assert.equal(requests.filter((r) => r.url.endsWith("/token")).length, 2);
    assert.deepEqual(
      rotations.sort(),
      [personal.refreshTokenFile, business.refreshTokenFile].sort(),
    );
    for (const req of requests.filter((r) => r.auth)) {
      assert.equal(
        req.auth,
        `Bearer ${req.url.includes("personal%40") ? personal.clientId : business.clientId}`,
      );
    }
    const restarted = fixture([business, personal]);
    await restarted.runtime.quoteEmailProvider.sendPrepared(refs[0], signal);
    assert.equal(restarted.requests.at(-1)?.auth, `Bearer ${personal.clientId}`);
  });

  it("rejects unknown senders, mismatched references and removed connections without fallback", async () => {
    const { runtime, requests } = fixture();
    await assert.rejects(runtime.quoteEmailProvider.prepare(input("personal"), signal), /sender/u);
    const key = resolveOutlookConnections(environment())[1].senderConnection;
    const ref = await runtime.quoteEmailProvider.prepare(input(key), signal);
    const before = requests.length;
    await assert.rejects(
      runtime.quoteEmailProvider.sendPrepared(
        { ...ref, providerCorrelationId: "different" },
        signal,
      ),
      /reference/u,
    );
    assert.equal(requests.length, before);
    const removed = fixture([personal]);
    assert.equal(
      (
        await removed.runtime.reconciliationAdapter.reconcile(
          { ...ref, provider: runtime.quoteEmailProvider.name },
          signal,
        )
      ).status,
      "unresolved",
    );
    await assert.rejects(removed.runtime.quoteEmailProvider.sendPrepared(ref, signal));
    assert.equal(removed.requests.length, 0);
  });

  it("does not try another account when a refresh is rejected", async () => {
    const seen: string[] = [];
    const runtime = createMicrosoftOutlookRuntimeFromEnv(environment(), {
      createRefreshTokenStore: () => ({
        async read() {
          return "revoked";
        },
        async replace() {
          throw new Error("must not rotate");
        },
      }),
      fetch: async (url) => {
        seen.push(String(url));
        return new Response(null, { status: 401 });
      },
    });
    assert.ok(runtime);
    const key = resolveOutlookConnections(environment())[1].senderConnection;
    await assert.rejects(runtime.quoteEmailProvider.prepare(input(key), signal));
    assert.deepEqual(seen, [`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`]);
  });

  it("rejects arbitrary token destinations and excessive granted scopes", async () => {
    const base = {
      clientId: personal.clientId,
      scopes: ["offline_access", "Mail.ReadWrite", "Mail.Send"],
      refreshTokenStore: {
        async read() {
          return "secret";
        },
        async replace() {},
      },
    };
    for (const authority of ["common", "organizations", "consumers/../common", "evil.example"]) {
      assert.throws(
        () =>
          new MicrosoftDelegatedAccessTokenSupplier({
            ...base,
            tokenEndpoint: `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`,
          }),
      );
    }
    const supplier = new MicrosoftDelegatedAccessTokenSupplier({
      ...base,
      tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      fetch: async () =>
        new Response(
          JSON.stringify({
            token_type: "Bearer",
            access_token: "token",
            expires_in: 3600,
            scope: "Mail.ReadWrite Mail.Send Files.Read.All",
          }),
        ),
    });
    await assert.rejects(supplier.getAccessToken(signal), /scopes/u);
  });
});
