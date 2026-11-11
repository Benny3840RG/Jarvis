import assert from "node:assert/strict";
import { test } from "node:test";

import { createGitHubSubjectProbe } from "../src/ownerGate/gitHubSubjectProbe.js";

type Call = { url: string; headers: Record<string, string>; redirect: unknown };

function fakeFetch(answers: Record<string, { status?: number; body?: unknown } | Error>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      redirect: init?.redirect,
    });
    const answer = answers[String(url)];
    if (answer === undefined) return new Response("{}", { status: 404 });
    if (answer instanceof Error) throw answer;
    return new Response(
      typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
      { status: answer.status ?? 200 },
    );
  }) as typeof fetch;
  return { calls, fetcher };
}

const BASE = "https://api.github.com/repos/example/repo";

test("the probe reads each kind of subject from its own read-only endpoint", async () => {
  const { calls, fetcher } = fakeFetch({
    [`${BASE}/pulls/7`]: { body: { head: { sha: "a".repeat(40) } } },
    [`${BASE}/issues/3`]: { body: { updated_at: "2026-11-01T00:00:00Z" } },
    [`${BASE}/branches/main`]: { body: { commit: { sha: "b".repeat(40) } } },
  });
  const probe = createGitHubSubjectProbe({ repository: "example/repo", fetch: fetcher });
  assert.equal(await probe({ kind: "pull-request", number: 7, revision: "x" }), "a".repeat(40));
  assert.equal(await probe({ kind: "issue", number: 3, revision: "x" }), "2026-11-01T00:00:00Z");
  assert.equal(await probe({ kind: "branch", name: "main", revision: "x" }), "b".repeat(40));
  for (const call of calls) {
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.redirect, "error");
  }
});

test("the probe sends a token only when one is configured", async () => {
  const { calls, fetcher } = fakeFetch({
    [`${BASE}/issues/3`]: { body: { updated_at: "2026-11-01T00:00:00Z" } },
  });
  const probe = createGitHubSubjectProbe({
    repository: "example/repo",
    token: "read-only-token",
    fetch: fetcher,
  });
  await probe({ kind: "issue", number: 3, revision: "x" });
  assert.equal(calls[0]!.headers.authorization, "Bearer read-only-token");
});

test("any failure or unexpected answer is reported as unknown, never as unchanged", async () => {
  const subject = { kind: "pull-request", number: 7, revision: "a".repeat(40) } as const;
  const answers: ({ status?: number; body?: unknown } | Error)[] = [
    new Error("network down"),
    { status: 403, body: { message: "rate limited" } },
    { status: 404, body: {} },
    { body: "not json" },
    { body: [] },
    { body: {} },
    { body: { head: null } },
    { body: { head: { sha: 42 } } },
  ];
  for (const answer of answers) {
    const { fetcher } = fakeFetch({ [`${BASE}/pulls/7`]: answer });
    const probe = createGitHubSubjectProbe({ repository: "example/repo", fetch: fetcher });
    assert.equal(await probe(subject), null, JSON.stringify(answer));
  }
});
