import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MicrosoftGraphQuoteEmailProvider,
  type MicrosoftGraphQuoteEmailProviderOptions,
} from "../src/quotes/microsoftGraphQuoteEmailProvider.js";
import type { QuoteEmailPrepareInput } from "../src/quotes/quoteEmailProvider.js";

const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function input(): QuoteEmailPrepareInput {
  return {
    quoteId: "quote-1",
    revision: {
      revisionId: "revision-1",
      ownerId: "owner-1",
      quoteId: "quote-1",
      revision: 1,
      revisionVersion: 2,
      status: "finalized",
      lineItems: [{ description: "Fence", quantity: 1, unitPrice: 100 }],
      subtotal: 100,
      tax: 10,
      total: 110,
      currency: "AUD",
      termsIncluded: true,
      fingerprint: `quote-revision:v1:sha256:${"a".repeat(64)}`,
      createdAt: 1,
      updatedAt: 2,
      finalizedAt: 2,
    },
    recipient: "client@example.com",
    subject: "Quote Q-1",
    body: "Please find your approved quote attached.",
    attachment: {
      filename: "Quote-Q-1-R1.pdf",
      mediaType: "application/pdf",
      digest:
        "quote-pdf:v1:sha256:86edbaa24831badfa0a8b04bb410141e2ee4182b6d0014493fe262a7a331c20b",
      bytes: PDF_BYTES,
    },
  };
}

type RecordedRequest = { url: string; init: RequestInit };

function providerWith(
  responses: Response[],
  requests: RecordedRequest[],
  overrides: Partial<MicrosoftGraphQuoteEmailProviderOptions> = {},
): MicrosoftGraphQuoteEmailProvider {
  return new MicrosoftGraphQuoteEmailProvider({
    mailbox: "benny@example.com",
    getAccessToken: async () => "secret-token",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      const response = responses.shift();
      if (!response) throw new Error("unexpected-fetch");
      return response;
    },
    ...overrides,
  });
}

describe("MicrosoftGraphQuoteEmailProvider", () => {
  it("creates a quote-only draft with the exact locked PDF and captures its immutable ID", async () => {
    const requests: RecordedRequest[] = [];
    const provider = providerWith(
      [
        new Response(JSON.stringify({ id: "immutable-message-id", isDraft: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ],
      requests,
    );

    const prepared = await provider.prepare(input(), new AbortController().signal);

    assert.deepEqual(prepared, {
      providerRequestId: "immutable-message-id",
      providerCorrelationId: "immutable-message-id",
    });
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      "https://graph.microsoft.com/v1.0/users/benny%40example.com/messages",
    );
    assert.equal(requests[0].init.method, "POST");
    const headers = new Headers(requests[0].init.headers);
    assert.equal(headers.get("authorization"), "Bearer secret-token");
    assert.equal(headers.get("prefer"), 'IdType="ImmutableId"');
    assert.equal(headers.get("content-type"), "application/json");

    const body = JSON.parse(String(requests[0].init.body)) as {
      subject: string;
      body: { contentType: string; content: string };
      toRecipients: Array<{ emailAddress: { address: string } }>;
      attachments: Array<Record<string, unknown>>;
    };
    assert.equal(body.subject, "Quote Q-1");
    assert.deepEqual(body.body, {
      contentType: "Text",
      content: "Please find your approved quote attached.",
    });
    assert.equal(body.toRecipients[0]?.emailAddress.address, "client@example.com");
    assert.deepEqual(body.attachments, [
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "Quote-Q-1-R1.pdf",
        contentType: "application/pdf",
        contentBytes: Buffer.from(PDF_BYTES).toString("base64"),
        isInline: false,
      },
    ]);
  });

  it("sends only a previously prepared immutable draft and treats 202 as acceptance", async () => {
    const requests: RecordedRequest[] = [];
    const provider = providerWith([new Response(null, { status: 202 })], requests);

    const result = await provider.sendPrepared(
      {
        providerRequestId: "immutable/message id",
        providerCorrelationId: "immutable/message id",
      },
      new AbortController().signal,
    );

    assert.deepEqual(result, { status: "accepted" });
    assert.equal(
      requests[0].url,
      "https://graph.microsoft.com/v1.0/users/benny%40example.com/messages/immutable%2Fmessage%20id/send",
    );
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.body, undefined);
    const headers = new Headers(requests[0].init.headers);
    assert.equal(headers.get("authorization"), "Bearer secret-token");
    assert.equal(headers.get("content-length"), "0");
    assert.equal(headers.get("prefer"), 'IdType="ImmutableId"');
  });

  it("fails closed on an empty mailbox before requesting a token or using fetch", () => {
    let tokenCalls = 0;
    assert.throws(
      () =>
        new MicrosoftGraphQuoteEmailProvider({
          mailbox: " ",
          getAccessToken: async () => {
            tokenCalls += 1;
            return "secret-token";
          },
          fetch: async () => {
            throw new Error("fetch-must-not-run");
          },
        }),
      /outlook-mailbox-invalid/u,
    );
    assert.equal(tokenCalls, 0);
  });

  it("rejects malformed draft responses with a stable redacted code", async () => {
    const requests: RecordedRequest[] = [];
    const provider = providerWith(
      [
        new Response(JSON.stringify({ isDraft: true, diagnostic: "sensitive" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ],
      requests,
    );

    await assert.rejects(
      provider.prepare(input(), new AbortController().signal),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "outlook-draft-response-invalid" &&
        !error.message.includes("sensitive"),
    );
  });

  it("does not leak Graph response bodies or tokens when sending is rejected", async () => {
    const requests: RecordedRequest[] = [];
    const provider = providerWith(
      [new Response("secret diagnostic body", { status: 403 })],
      requests,
    );

    await assert.rejects(
      provider.sendPrepared(
        { providerRequestId: "message-1", providerCorrelationId: "message-1" },
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "outlook-send-rejected-403" &&
        !error.message.includes("secret") &&
        !error.message.includes("token"),
    );
  });

  it("remains unconfigured by default", async () => {
    const { createQuoteEmailProviderFromEnv } = await import("../src/quotes/quoteEmailProvider.js");
    assert.equal(createQuoteEmailProviderFromEnv(), null);
  });
});
