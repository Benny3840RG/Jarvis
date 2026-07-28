import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  prepareRegisterAndSendQuoteEmail,
  QuoteEmailAcceptedIndeterminateError,
  type PreparedQuoteEmailProvider,
} from "../src/quotes/quoteEmailDeliveryProtocol.js";
import type { QuoteEmailPrepareInput } from "../src/quotes/quoteEmailProvider.js";

function input(): QuoteEmailPrepareInput {
  const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
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
      bytes,
    },
  };
}

describe("prepared quote email delivery protocol", () => {
  it("persists the immutable provider reference before attempting send", async () => {
    const events: string[] = [];
    const provider: PreparedQuoteEmailProvider = {
      name: "microsoft-graph-mail-v1",
      async prepare() {
        events.push("prepare");
        return {
          providerRequestId: "immutable-message-1",
          providerCorrelationId: "immutable-message-1",
        };
      },
      async sendPrepared() {
        events.push("send");
        return { status: "accepted" };
      },
    };

    await assert.rejects(
      prepareRegisterAndSendQuoteEmail({
        provider,
        input: input(),
        signal: new AbortController().signal,
        async register(reference) {
          events.push(`register:${reference.providerRequestId}`);
        },
      }),
      (error: unknown) =>
        error instanceof QuoteEmailAcceptedIndeterminateError &&
        error.code === "quote-email-accepted-indeterminate",
    );

    assert.deepEqual(events, ["prepare", "register:immutable-message-1", "send"]);
  });

  it("never sends when durable reference registration fails", async () => {
    const events: string[] = [];
    const provider: PreparedQuoteEmailProvider = {
      name: "microsoft-graph-mail-v1",
      async prepare() {
        events.push("prepare");
        return {
          providerRequestId: "immutable-message-1",
          providerCorrelationId: "immutable-message-1",
        };
      },
      async sendPrepared() {
        events.push("send");
        return { status: "accepted" };
      },
    };

    await assert.rejects(
      prepareRegisterAndSendQuoteEmail({
        provider,
        input: input(),
        signal: new AbortController().signal,
        async register() {
          events.push("register");
          throw new Error("ledger-unavailable");
        },
      }),
      /ledger-unavailable/u,
    );

    assert.deepEqual(events, ["prepare", "register"]);
  });

  it("does not register or send when draft preparation fails", async () => {
    const events: string[] = [];
    const provider: PreparedQuoteEmailProvider = {
      name: "microsoft-graph-mail-v1",
      async prepare() {
        events.push("prepare");
        throw new Error("draft-failed");
      },
      async sendPrepared() {
        events.push("send");
        return { status: "accepted" };
      },
    };

    await assert.rejects(
      prepareRegisterAndSendQuoteEmail({
        provider,
        input: input(),
        signal: new AbortController().signal,
        async register() {
          events.push("register");
        },
      }),
      /draft-failed/u,
    );

    assert.deepEqual(events, ["prepare"]);
  });
});
