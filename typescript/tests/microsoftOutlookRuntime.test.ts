import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RefreshTokenStore } from "../src/auth/microsoftDelegatedOAuth.js";
import { createMicrosoftOutlookRuntimeFromEnv } from "../src/auth/microsoftOutlookRuntime.js";
import { OUTLOOK_MAIL_RECONCILIATION_PROVIDER } from "../src/reconciliation/outlookMailReconciliationAdapter.js";

const enabledEnvironment = {
  JARVIS_OUTLOOK_ENABLED: "true",
  JARVIS_OUTLOOK_CLIENT_ID: "client-id",
  JARVIS_OUTLOOK_MAILBOX: "thebeeztreez@outlook.com",
  JARVIS_OUTLOOK_REFRESH_TOKEN_FILE: "/run/secrets/jarvis-outlook-refresh-token",
} as const;

class MemoryRefreshTokenStore implements RefreshTokenStore {
  constructor(private token: string) {}

  async read(): Promise<string> {
    return this.token;
  }

  async replace(token: string): Promise<void> {
    this.token = token;
  }
}

describe("Microsoft Outlook runtime composition", () => {
  it("stays inert while disabled", () => {
    let fetches = 0;
    const runtime = createMicrosoftOutlookRuntimeFromEnv(
      {},
      {
        refreshTokenStore: new MemoryRefreshTokenStore("unused"),
        fetch: async () => {
          fetches += 1;
          throw new Error("Disabled runtime must not perform network I/O.");
        },
      },
    );

    assert.equal(runtime, null);
    assert.equal(fetches, 0);
  });

  it("shares one delegated token supplier between sending and reconciliation", async () => {
    let tokenRefreshes = 0;
    const graphRequests: Array<{ method: string; url: string }> = [];
    const runtime = createMicrosoftOutlookRuntimeFromEnv(enabledEnvironment, {
      refreshTokenStore: new MemoryRefreshTokenStore("refresh-token"),
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/oauth2/v2.0/token")) {
          tokenRefreshes += 1;
          return new Response(
            JSON.stringify({
              token_type: "Bearer",
              access_token: "access-token",
              expires_in: 3600,
              scope: "offline_access Mail.ReadWrite Mail.Send",
            }),
            { status: 200 },
          );
        }

        graphRequests.push({ method: init?.method ?? "GET", url });
        if (init?.method === "GET") {
          return new Response(
            JSON.stringify({
              id: "immutable-message-id",
              isDraft: false,
              sentDateTime: "2026-07-28T00:00:00.000Z",
              internetMessageId: "<message@example.test>",
            }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 202 });
      },
    });

    assert.ok(runtime);
    assert.equal(runtime.quoteEmailProvider.name, OUTLOOK_MAIL_RECONCILIATION_PROVIDER);

    const reference = {
      provider: OUTLOOK_MAIL_RECONCILIATION_PROVIDER,
      providerRequestId: "immutable-message-id",
      providerCorrelationId: "immutable-message-id",
    };
    const signal = new AbortController().signal;
    const reconciliation = await runtime.reconciliationAdapter.reconcile(reference, signal);
    assert.equal(reconciliation.status, "succeeded");
    assert.deepEqual(await runtime.quoteEmailProvider.sendPrepared(reference, signal), {
      status: "accepted",
    });

    assert.equal(tokenRefreshes, 1);
    assert.deepEqual(
      graphRequests.map(({ method }) => method),
      ["GET", "POST"],
    );
    assert.ok(
      graphRequests.every(({ url }) =>
        url.startsWith("https://graph.microsoft.com/v1.0/users/thebeeztreez%40outlook.com/"),
      ),
    );
  });
});
