import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MicrosoftGraphMessageStatusClient } from "../src/reconciliation/microsoftGraphMessageStatusClient.js";
import { OutlookReconciliationError } from "../src/reconciliation/outlookMailReconciliationAdapter.js";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const INPUT = {
  mailbox: "thebeeztreez+quotes@outlook.com",
  immutableMessageId: "immutable/message 1",
} as const;

function clientReturning(response: Response): MicrosoftGraphMessageStatusClient {
  return new MicrosoftGraphMessageStatusClient({
    async getAccessToken() {
      return "access-token";
    },
    async fetch() {
      return response;
    },
  });
}

describe("MicrosoftGraphMessageStatusClient", () => {
  it("issues one narrow immutable-ID GET and returns the selected message status", async () => {
    const calls: Array<{ input: FetchInput; init: FetchInit }> = [];
    let tokenSignal: AbortSignal | undefined;
    const client = new MicrosoftGraphMessageStatusClient({
      async getAccessToken(signal) {
        tokenSignal = signal;
        return "access-token";
      },
      async fetch(input, init) {
        calls.push({ input, init });
        return new Response(
          JSON.stringify({
            id: "immutable/message 1",
            isDraft: false,
            sentDateTime: "2026-07-28T00:00:00.000Z",
            internetMessageId: "<quote-1@example.invalid>",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    const signal = new AbortController().signal;

    const result = await client.getMessageStatus({
      ...INPUT,
      signal,
    });

    assert.deepEqual(result, {
      status: "found",
      immutableMessageId: "immutable/message 1",
      isDraft: false,
      sentDateTime: "2026-07-28T00:00:00.000Z",
      internetMessageId: "<quote-1@example.invalid>",
    });
    assert.equal(tokenSignal, signal);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    const url = new URL(String(call.input));
    assert.equal(url.origin, "https://graph.microsoft.com");
    assert.equal(
      url.pathname,
      "/v1.0/users/thebeeztreez%2Bquotes%40outlook.com/messages/immutable%2Fmessage%201",
    );
    assert.equal(url.searchParams.get("$select"), "id,isDraft,sentDateTime,internetMessageId");
    assert.deepEqual([...url.searchParams.keys()], ["$select"]);
    assert.equal(call.init?.method, "GET");
    assert.equal(call.init?.body, undefined);
    assert.equal(call.init?.redirect, "error");
    assert.equal(call.init?.signal, signal);
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("authorization"), "Bearer access-token");
    assert.equal(headers.get("prefer"), 'IdType="ImmutableId"');
  });

  it("classifies non-terminal Graph responses without reading provider messages", async () => {
    const cases: Array<{
      response: Response;
      expected: object;
    }> = [
      {
        response: new Response("private", { status: 404 }),
        expected: { status: "not-observable" },
      },
      {
        response: new Response("private", { status: 410 }),
        expected: { status: "not-observable" },
      },
      {
        response: new Response("private", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
        expected: { status: "throttled", retryAfterMs: 120_000 },
      },
      { response: new Response("private", { status: 500 }), expected: { status: "unavailable" } },
      { response: new Response("private", { status: 503 }), expected: { status: "unavailable" } },
      { response: new Response("private", { status: 504 }), expected: { status: "unavailable" } },
      { response: new Response("private", { status: 400 }), expected: { status: "rejected" } },
      { response: new Response("private", { status: 409 }), expected: { status: "rejected" } },
      { response: new Response("private", { status: 422 }), expected: { status: "rejected" } },
    ];

    for (const { response, expected } of cases) {
      assert.deepEqual(
        await clientReturning(response).getMessageStatus({
          ...INPUT,
          signal: new AbortController().signal,
        }),
        expected,
      );
    }
  });

  it("accepts only bounded integer Retry-After seconds", async () => {
    for (const value of ["0", "301", "Wed, 28 Jul 2026 00:00:00 GMT", "junk"]) {
      const result = await clientReturning(
        new Response(null, { status: 429, headers: { "retry-after": value } }),
      ).getMessageStatus({
        ...INPUT,
        signal: new AbortController().signal,
      });
      assert.deepEqual(result, { status: "throttled" });
    }

    assert.deepEqual(
      await clientReturning(new Response(null, { status: 429 })).getMessageStatus({
        ...INPUT,
        signal: new AbortController().signal,
      }),
      { status: "throttled" },
    );
  });

  it("returns invalid for malformed successful payloads", async () => {
    const malformed = await clientReturning(
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ).getMessageStatus({
      ...INPUT,
      signal: new AbortController().signal,
    });
    assert.deepEqual(malformed, { status: "invalid" });

    const wrongTypes = await clientReturning(
      Response.json({ id: 42, isDraft: "false" }),
    ).getMessageStatus({
      ...INPUT,
      signal: new AbortController().signal,
    });
    assert.deepEqual(wrongTypes, { status: "invalid" });
  });

  it("throws stable authorization codes for missing tokens and 401 or 403", async () => {
    const emptyToken = new MicrosoftGraphMessageStatusClient({
      async getAccessToken() {
        return "   ";
      },
      async fetch() {
        assert.fail("An empty token must prevent the request.");
      },
    });
    await assert.rejects(
      emptyToken.getMessageStatus({
        ...INPUT,
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof OutlookReconciliationError);
        assert.equal(error.code, "outlook-graph-authorization-failed");
        return true;
      },
    );

    for (const status of [401, 403]) {
      await assert.rejects(
        clientReturning(new Response("private provider body", { status })).getMessageStatus({
          ...INPUT,
          signal: new AbortController().signal,
        }),
        (error: unknown) => {
          assert.ok(error instanceof OutlookReconciliationError);
          assert.equal(error.code, "outlook-graph-authorization-failed");
          assert.doesNotMatch(String(error), /private provider body/);
          return true;
        },
      );
    }
  });

  it("redacts token-supplier and network failures", async () => {
    const leakedValues = [
      "secret-token",
      INPUT.mailbox,
      INPUT.immutableMessageId,
      "graph-request-123",
    ];
    const tokenFailure = new MicrosoftGraphMessageStatusClient({
      async getAccessToken() {
        throw new Error(leakedValues.join(" "));
      },
      async fetch() {
        assert.fail("Token failure must prevent the request.");
      },
    });
    await assert.rejects(
      tokenFailure.getMessageStatus({
        ...INPUT,
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof OutlookReconciliationError);
        assert.equal(error.code, "outlook-graph-token-unavailable");
        for (const value of leakedValues) assert.doesNotMatch(String(error), new RegExp(value));
        return true;
      },
    );

    const networkFailure = new MicrosoftGraphMessageStatusClient({
      async getAccessToken() {
        return "access-token";
      },
      async fetch() {
        throw new Error(leakedValues.join(" "));
      },
    });
    await assert.rejects(
      networkFailure.getMessageStatus({
        ...INPUT,
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof OutlookReconciliationError);
        assert.equal(error.code, "outlook-graph-request-failed");
        for (const value of leakedValues) assert.doesNotMatch(String(error), new RegExp(value));
        return true;
      },
    );
  });
});
