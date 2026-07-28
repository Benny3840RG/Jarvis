import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OutlookMailReconciliationAdapter,
  type OutlookMessageStatusClient,
  type OutlookMessageStatusResult,
} from "../src/reconciliation/outlookMailReconciliationAdapter.js";

const REFERENCE = {
  provider: "microsoft-graph-mail-v1",
  providerRequestId: "immutable-message-1",
  providerCorrelationId: "jarvis-correlation-1",
} as const;

class RecordingStatusClient implements OutlookMessageStatusClient {
  readonly calls: Array<{
    mailbox: string;
    immutableMessageId: string;
    signal: AbortSignal;
  }> = [];

  constructor(private readonly result: OutlookMessageStatusResult) {}

  async getMessageStatus(input: {
    mailbox: string;
    immutableMessageId: string;
    signal: AbortSignal;
  }): Promise<OutlookMessageStatusResult> {
    this.calls.push(input);
    return this.result;
  }
}

function adapterFor(result: OutlookMessageStatusResult): {
  adapter: OutlookMailReconciliationAdapter;
  client: RecordingStatusClient;
} {
  const client = new RecordingStatusClient(result);
  return {
    adapter: new OutlookMailReconciliationAdapter({
      mailbox: "thebeeztreez@outlook.com",
      client,
    }),
    client,
  };
}

describe("OutlookMailReconciliationAdapter", () => {
  it("resolves a matching non-draft immutable message as succeeded", async () => {
    const { adapter, client } = adapterFor({
      status: "found",
      immutableMessageId: "immutable-message-1",
      isDraft: false,
      sentDateTime: "2026-07-28T00:00:00.000Z",
      internetMessageId: "<quote-1@example.invalid>",
    });
    const signal = new AbortController().signal;

    const result = await adapter.reconcile(REFERENCE, signal);

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") assert.fail("Expected sent message to reconcile.");
    assert.match(result.outputDigest ?? "", /^outlook-mail-status:v1:sha256:[a-f0-9]{64}$/);
    assert.deepEqual(client.calls, [
      {
        mailbox: "thebeeztreez@outlook.com",
        immutableMessageId: "immutable-message-1",
        signal,
      },
    ]);
  });

  it("keeps non-terminal Outlook observations unresolved", async () => {
    const cases: Array<{
      observation: OutlookMessageStatusResult;
      expected: {
        status: "unresolved";
        errorCode: string;
        retryAfterMs?: number;
      };
    }> = [
      {
        observation: {
          status: "found",
          immutableMessageId: "immutable-message-1",
          isDraft: true,
        },
        expected: {
          status: "unresolved",
          errorCode: "outlook-message-still-draft",
        },
      },
      {
        observation: { status: "not-observable" },
        expected: {
          status: "unresolved",
          errorCode: "outlook-message-not-observable",
        },
      },
      {
        observation: { status: "throttled", retryAfterMs: 120_000 },
        expected: {
          status: "unresolved",
          errorCode: "outlook-graph-throttled",
          retryAfterMs: 120_000,
        },
      },
      {
        observation: { status: "unavailable" },
        expected: {
          status: "unresolved",
          errorCode: "outlook-graph-unavailable",
        },
      },
      {
        observation: { status: "rejected" },
        expected: {
          status: "unresolved",
          errorCode: "outlook-graph-request-rejected",
        },
      },
      {
        observation: { status: "invalid" },
        expected: {
          status: "unresolved",
          errorCode: "outlook-message-status-invalid",
        },
      },
    ];

    for (const { observation, expected } of cases) {
      const { adapter } = adapterFor(observation);
      assert.deepEqual(
        await adapter.reconcile(REFERENCE, new AbortController().signal),
        expected,
      );
    }
  });
});
