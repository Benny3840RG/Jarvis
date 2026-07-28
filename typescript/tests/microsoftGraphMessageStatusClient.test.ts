import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MicrosoftGraphMessageStatusClient } from "../src/reconciliation/microsoftGraphMessageStatusClient.js";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

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
      mailbox: "thebeeztreez+quotes@outlook.com",
      immutableMessageId: "immutable/message 1",
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
});
