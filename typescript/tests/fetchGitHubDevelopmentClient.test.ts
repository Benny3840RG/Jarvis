import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FetchGitHubDevelopmentClient } from "../src/development/githubDevelopment.js";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function checkRun(
  name: string,
  conclusion: string | null,
): {
  name: string;
  status: "completed";
  conclusion: string | null;
} {
  return { name, status: "completed", conclusion };
}

describe("FetchGitHubDevelopmentClient.getCommitChecks", () => {
  it("follows pagination past the first 100 check runs instead of silently truncating", async () => {
    const calls: Array<{ input: FetchInput; init: FetchInit }> = [];
    const firstPage = Array.from({ length: 100 }, (_, i) => checkRun(`check-${i}`, "success"));
    const secondPage = [checkRun("check-100", "failure"), checkRun("check-101", "success")];

    const client = new FetchGitHubDevelopmentClient("test-token", {
      async fetch(input, init) {
        calls.push({ input, init });
        const url = new URL(String(input));
        const page = url.searchParams.get("page");
        if (page === "1" || page === null) {
          return jsonResponse({ total_count: 102, check_runs: firstPage });
        }
        if (page === "2") {
          return jsonResponse({ total_count: 102, check_runs: secondPage });
        }
        return jsonResponse({ total_count: 102, check_runs: [] });
      },
    });

    const checks = await client.getCommitChecks({
      repository: "Benny3840RG/Jarvis",
      sha: "a".repeat(40),
      signal: new AbortController().signal,
    });

    assert.equal(checks.length, 102);
    assert.equal(checks[100]?.name, "check-100");
    assert.equal(checks[100]?.conclusion, "failure");
    assert.equal(calls.length, 2);
  });

  it("stops after a single page when total_count fits within the first page", async () => {
    const client = new FetchGitHubDevelopmentClient("test-token", {
      async fetch() {
        return jsonResponse({
          total_count: 2,
          check_runs: [checkRun("check-0", "success"), checkRun("check-1", "success")],
        });
      },
    });

    const checks = await client.getCommitChecks({
      repository: "Benny3840RG/Jarvis",
      sha: "b".repeat(40),
      signal: new AbortController().signal,
    });

    assert.equal(checks.length, 2);
  });

  it("rejects an incomplete result when GitHub returns an empty page before total_count is reached", async () => {
    let requests = 0;
    const client = new FetchGitHubDevelopmentClient("test-token", {
      async fetch() {
        requests++;
        return jsonResponse({ total_count: 500, check_runs: [] });
      },
    });

    await assert.rejects(
      client.getCommitChecks({
        repository: "Benny3840RG/Jarvis",
        sha: "c".repeat(40),
        signal: new AbortController().signal,
      }),
      /GitHub check-run evidence is incomplete/,
    );

    assert.equal(requests, 1);
  });

  it("rejects an incomplete result when the bounded page limit is reached", async () => {
    let requests = 0;
    const page = Array.from({ length: 100 }, (_, i) => checkRun(`check-${i}`, "success"));
    const client = new FetchGitHubDevelopmentClient("test-token", {
      async fetch() {
        requests++;
        return jsonResponse({ total_count: 2_001, check_runs: page });
      },
    });

    await assert.rejects(
      client.getCommitChecks({
        repository: "Benny3840RG/Jarvis",
        sha: "d".repeat(40),
        signal: new AbortController().signal,
      }),
      /GitHub check-run evidence is incomplete/,
    );

    assert.equal(requests, 20);
  });
});
