import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import {
  GITHUB_READ_PLANE_TOOLS,
  GitHubWriteForbiddenError,
  isGitHubReadOnlyTool,
} from "../src/development/githubReadPlane.js";
import { GithubReadEndpointError } from "../src/development/githubReadEndpoints.js";
import {
  GithubReadPlaneClient,
  GitHubReadRestError,
} from "../src/development/githubReadPlaneClient.js";
import type { InstallationToken } from "../src/development/githubReadAuth.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const config = {
  appId: "1",
  installationId: "2",
  privateKeyPem: PEM,
  repository: { owner: "Benny3840RG", repo: "Jarvis" },
} as const;

// Verbs that mutate GitHub state or exercise authority. No client method or
// exposed tool may carry one — the read plane is reads only.
const MUTATION_VERBS = [
  "merge",
  "create",
  "update",
  "delete",
  "write",
  "approve",
  "reject",
  "close",
  "dispatch",
  "push",
  "comment",
  "review",
  "submit",
];

function tokenStub(): { mint: () => Promise<InstallationToken>; calls: () => number } {
  let calls = 0;
  return {
    mint: async () => {
      calls += 1;
      return Object.freeze({ token: "ghs_stub", expiresAt: new Date("2999-01-01T00:00:00Z") });
    },
    calls: () => calls,
  };
}

describe("GitHub read-plane surface (PR F, auth/network slice)", () => {
  it("exposes no write, merge or approve operation", () => {
    // The declared tool surface: every tool must classify as read-only (the
    // classifier tokenises, so a read like "list_..._comments" is not mistaken
    // for the "comment" write verb).
    for (const tool of GITHUB_READ_PLANE_TOOLS) {
      assert.equal(isGitHubReadOnlyTool(tool), true, `${tool} must be read-only`);
    }
    // The client's own method surface (our own naming; a mutation verb here
    // would betray a write path).
    const methods = Object.getOwnPropertyNames(GithubReadPlaneClient.prototype).filter(
      (name) => name !== "constructor",
    );
    for (const method of methods) {
      for (const verb of MUTATION_VERBS) {
        assert.equal(
          method.toLowerCase().includes(verb),
          false,
          `client method ${method} must not contain "${verb}"`,
        );
      }
    }
  });

  it("never exposes the App private key or a minted token via serialization, inspection, or enumeration", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof globalThis.fetch;
    const client = new GithubReadPlaneClient(config, {
      fetch: fakeFetch,
      // Mint a recognisable token so we can prove it never surfaces either.
      mint: async () =>
        Object.freeze({ token: "ghs_secret_token", expiresAt: new Date("2999-01-01T00:00:00Z") }),
    });
    // Trigger a read so a token is cached in memory.
    await client.read({ tool: "github_get_issue", params: { issueNumber: 1 } });

    const serialized = JSON.stringify(client);
    const inspected = inspect(client, { depth: null });
    for (const dump of [serialized, inspected]) {
      assert.doesNotMatch(dump, /PRIVATE KEY/, dump);
      assert.doesNotMatch(dump, /ghs_secret_token/, dump);
    }
    // No enumerable own property carries the config or token.
    assert.deepEqual(Object.keys(client), []);
    for (const name of Object.getOwnPropertyNames(client)) {
      const value = JSON.stringify((client as unknown as Record<string, unknown>)[name] ?? null);
      assert.doesNotMatch(value, /PRIVATE KEY/, name);
    }
  });

  it("reads an allowlisted tool through a fresh short-lived token, bound to the configured repository", async () => {
    const stub = tokenStub();
    let seenUrl: string | undefined;
    const fakeFetch = (async (input: URL | RequestInfo) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({ number: 1 }), { status: 200 });
    }) as typeof globalThis.fetch;

    const client = new GithubReadPlaneClient(config, { fetch: fakeFetch, mint: stub.mint });
    const body = (await client.read({
      tool: "github_get_pull_request",
      params: { pullNumber: 1 },
    })) as { number: number };
    assert.equal(body.number, 1);
    // The path is fixed to the configured repository — the caller never supplied it.
    assert.equal(seenUrl, "https://api.github.com/repos/Benny3840RG/Jarvis/pulls/1");
    assert.equal(stub.calls(), 1);
  });

  it("refuses a write/merge tool name before any token is minted or request dispatched", async () => {
    const stub = tokenStub();
    let fetched = false;
    const fakeFetch = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const client = new GithubReadPlaneClient(config, { fetch: fakeFetch, mint: stub.mint });

    await assert.rejects(
      () => client.read({ tool: "github_merge_pull_request", params: { pullNumber: 1 } }),
      GitHubWriteForbiddenError,
    );
    assert.equal(stub.calls(), 0);
    assert.equal(fetched, false);
  });

  it("refuses a read-shaped tool that is not on the allowlist", async () => {
    const stub = tokenStub();
    const client = new GithubReadPlaneClient(config, {
      fetch: (async () => new Response("{}", { status: 200 })) as typeof globalThis.fetch,
      mint: stub.mint,
    });
    // "get_repository" is read-verb-shaped but not a declared read-plane tool.
    await assert.rejects(() => client.read({ tool: "get_repository" }), GitHubWriteForbiddenError);
    assert.equal(stub.calls(), 0);
  });

  it("refuses a request with missing or invalid params before minting a token", async () => {
    const stub = tokenStub();
    let fetched = false;
    const fakeFetch = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const client = new GithubReadPlaneClient(config, { fetch: fakeFetch, mint: stub.mint });

    // A PR read with no pull number, and a commit read with a non-SHA ref, both
    // fail at path-build time — before any token is minted or request dispatched.
    await assert.rejects(
      () => client.read({ tool: "github_get_pull_request", params: {} }),
      GithubReadEndpointError,
    );
    await assert.rejects(
      () => client.read({ tool: "github_get_commit", params: { ref: "../etc/passwd" } }),
      GithubReadEndpointError,
    );
    assert.equal(stub.calls(), 0, "no token minted for an unbuildable request");
    assert.equal(fetched, false);
  });

  it("reuses a live token in memory and re-mints only after expiry", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof globalThis.fetch;
    let clock = new Date("2026-01-01T00:00:00Z");
    let mints = 0;
    const client = new GithubReadPlaneClient(config, {
      fetch: fakeFetch,
      mint: async () => {
        mints += 1;
        // Token lives 10 minutes from the current clock.
        return Object.freeze({
          token: "ghs_stub",
          expiresAt: new Date(clock.getTime() + 10 * 60 * 1000),
        });
      },
      now: () => clock,
    });
    // Two reads within validity mint once.
    await client.read({ tool: "github_get_issue", params: { issueNumber: 1 } });
    await client.read({ tool: "github_get_issue", params: { issueNumber: 2 } });
    assert.equal(mints, 1);
    // After the token lapses, a fresh read must re-mint.
    clock = new Date("2026-01-01T00:20:00Z");
    await client.read({ tool: "github_get_issue", params: { issueNumber: 3 } });
    assert.equal(mints, 2);
  });

  it("surfaces a redacted rest error on a non-ok read", async () => {
    const stub = tokenStub();
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      })) as typeof globalThis.fetch;
    const client = new GithubReadPlaneClient(config, { fetch: fakeFetch, mint: stub.mint });
    await assert.rejects(
      () => client.read({ tool: "github_get_pull_request", params: { pullNumber: 9 } }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubReadRestError);
        assert.match(error.message, /404/);
        assert.doesNotMatch(error.message, /ghs_/);
        return true;
      },
    );
  });
});
