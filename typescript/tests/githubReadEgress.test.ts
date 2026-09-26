import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertGitHubApiUrl,
  GITHUB_API_ORIGIN,
  GitHubEgressForbiddenError,
  guardedGitHubFetch,
} from "../src/development/githubReadEgress.js";

describe("GitHub read-plane egress boundary (PR F, auth/network slice)", () => {
  it("hard-codes the single approved API origin", () => {
    assert.equal(GITHUB_API_ORIGIN, "https://api.github.com");
  });

  it("admits only exact-origin https URLs", () => {
    for (const url of [
      "https://api.github.com/repos/o/r/pulls/1",
      "https://api.github.com/app/installations/5/access_tokens",
      // Default port is normalised away, so an explicit :443 is the same origin.
      "https://api.github.com:443/repos/o/r",
    ]) {
      assert.doesNotThrow(() => assertGitHubApiUrl(url), url);
      assert.equal(assertGitHubApiUrl(url).origin, GITHUB_API_ORIGIN, url);
    }
  });

  it("refuses any host, scheme, port, credential or redirect that escapes the origin", () => {
    for (const url of [
      "http://api.github.com/x", // not https
      "git://api.github.com/x", // git transport
      "ws://api.github.com/x", // websocket
      "ftp://api.github.com/x", // other scheme
      "https://raw.githubusercontent.com/o/r/main/f", // raw-content host
      "https://uploads.github.com/x", // uploads host
      "https://codeload.github.com/x", // codeload host
      "https://github.com/o/r", // web host
      "https://api.github.com.evil.com/x", // look-alike host
      "https://evil.com/api.github.com", // unrelated host
      "https://user:token@api.github.com/x", // embedded credentials
      "https://api.github.com:8443/x", // non-standard port
      "not-a-url",
    ]) {
      assert.throws(() => assertGitHubApiUrl(url), GitHubEgressForbiddenError, url);
    }
  });

  it("routes an approved request through fetch with redirect handling forced to error", async () => {
    let seenUrl: string | undefined;
    let seenRedirect: RequestRedirect | undefined;
    const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      seenUrl = String(input);
      seenRedirect = init?.redirect;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    const response = await guardedGitHubFetch(
      fakeFetch,
      "https://api.github.com/repos/o/r/pulls/1",
      { method: "GET" },
    );
    assert.equal(response.status, 200);
    assert.equal(seenUrl, "https://api.github.com/repos/o/r/pulls/1");
    assert.equal(seenRedirect, "error");
  });

  it("refuses to dispatch an off-origin request at all", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    await assert.rejects(
      () => guardedGitHubFetch(fakeFetch, "https://raw.githubusercontent.com/o/r/f", {}),
      GitHubEgressForbiddenError,
    );
    assert.equal(called, false, "off-origin request must never reach fetch");
  });

  it("refuses a caller that asks for redirect following", async () => {
    const fakeFetch = (async () => new Response("{}", { status: 200 })) as typeof globalThis.fetch;
    await assert.rejects(
      () => guardedGitHubFetch(fakeFetch, "https://api.github.com/x", { redirect: "follow" }),
      GitHubEgressForbiddenError,
    );
  });
});
