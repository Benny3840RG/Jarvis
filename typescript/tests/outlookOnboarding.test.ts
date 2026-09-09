import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { authorizeOutlookConnection } from "../src/auth/outlookOnboarding.js";
import { resolveOutlookConnections } from "../src/auth/microsoftOutlookConnections.js";

describe("Outlook browser onboarding", () => {
  for (const denied of [false, true])
    it(
      denied
        ? "does not persist credentials for a rejected mailbox"
        : "uses PKCE and state, verifies access and persists rotation without sending",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "outlook-onboard-"));
        const connection = resolveOutlookConnections({
          JARVIS_OUTLOOK_CONNECTIONS_JSON: JSON.stringify([
            {
              id: "personal",
              clientId: "aaaaaaaa-2222-3333-4444-555555555555",
              mailbox: "test@outlook.com",
              refreshTokenFile: join(dir, "refresh.token"),
            },
          ]),
        })[0];
        const requests: string[] = [];
        try {
          const run = authorizeOutlookConnection(connection, {
            async showAuthorizationUrl(url) {
              const auth = new URL(url);
              assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
              assert.equal(auth.searchParams.get("prompt"), "select_account");
              const callback = new URL(auth.searchParams.get("redirect_uri")!);
              callback.searchParams.set("code", "test-code");
              callback.searchParams.set("state", "wrong");
              assert.equal((await fetch(callback)).status, 400);
              callback.searchParams.set("state", auth.searchParams.get("state")!);
              assert.equal((await fetch(callback)).status, 200);
            },
            fetch: async (url, init) => {
              requests.push(String(url));
              if (String(url).endsWith("/token")) {
                const form = new URLSearchParams(String(init?.body));
                if (form.get("grant_type") === "authorization_code")
                  assert.ok(form.get("code_verifier"));
                return new Response(
                  JSON.stringify({
                    token_type: "Bearer",
                    access_token: "access",
                    refresh_token:
                      form.get("grant_type") === "authorization_code" ? "initial" : "rotated",
                    expires_in: 3600,
                    scope: "Mail.ReadWrite Mail.Send",
                  }),
                );
              }
              assert.equal(init?.method, "GET");
              assert.match(String(url), /users\/test%40outlook.com\/mailFolders\/inbox/u);
              return denied
                ? new Response(null, { status: 403 })
                : new Response(JSON.stringify({ id: "inbox-id" }));
            },
          });
          if (denied) {
            await assert.rejects(run, /mailbox-probe-rejected-403/u);
            assert.deepEqual(await readdir(dir), []);
          } else {
            await run;
            assert.equal(await readFile(connection.config.refreshTokenFile, "utf8"), "rotated\n");
            assert.equal(requests.length, 3);
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
});
