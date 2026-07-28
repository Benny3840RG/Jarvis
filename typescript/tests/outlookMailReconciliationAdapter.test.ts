import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OutlookMailReconciliationAdapter,
  OutlookReconciliationError,
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

  constructor(private readonly result: OutlookMessageStatusResult | Error) {}

  async getMessageStatus(input: {
    mailbox: string;
    immutableMessageId: string;
    signal: AbortSignal;
  }): Promise<OutlookMessageStatusResult> {
    this.calls.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function adapterFor(result: OutlookMessageStatusResult | Error): {
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
      assert.deepEqual(await adapter.reconcile(REFERENCE, new AbortController().signal), expected);
    }
  });

  it("rejects unsafe provider references before consulting Outlook", async () => {
    const invalidReferences = [
      { ...REFERENCE, provider: "other-provider" },
      { ...REFERENCE, providerRequestId: "" },
      { ...REFERENCE, providerRequestId: "immutable\u0000message" },
      { ...REFERENCE, providerRequestId: "x".repeat(1_025) },
      { ...REFERENCE, providerCorrelationId: "" },
    ];

    for (const reference of invalidReferences) {
      const { adapter, client } = adapterFor({ status: "not-observable" });
      assert.deepEqual(await adapter.reconcile(reference, new AbortController().signal), {
        status: "unresolved",
        errorCode: "outlook-provider-reference-invalid",
      });
      assert.equal(client.calls.length, 0);
    }
  });

  it("never resolves malformed or mismatched found observations", async () => {
    const invalidObservations: OutlookMessageStatusResult[] = [
      {
        status: "found",
        immutableMessageId: "different-message",
        isDraft: false,
        sentDateTime: "2026-07-28T00:00:00.000Z",
      },
      {
        status: "found",
        immutableMessageId: "immutable-message-1",
        isDraft: false,
      },
      {
        status: "found",
        immutableMessageId: "immutable-message-1",
        isDraft: false,
        sentDateTime: "not-a-date",
      },
    ];

    for (const observation of invalidObservations) {
      const { adapter } = adapterFor(observation);
      assert.deepEqual(await adapter.reconcile(REFERENCE, new AbortController().signal), {
        status: "unresolved",
        errorCode: "outlook-message-status-invalid",
      });
    }
  });

  it("rethrows client failures using only a stable redacted code", async () => {
    const leakedValues = [
      "secret-token",
      "thebeeztreez@outlook.com",
      "immutable-message-1",
      "graph-request-123",
    ];
    const { adapter } = adapterFor(
      new Error(
        `Bearer ${leakedValues[0]} mailbox ${leakedValues[1]} message ${leakedValues[2]} request ${leakedValues[3]}`,
      ),
    );

    await assert.rejects(
      adapter.reconcile(REFERENCE, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "outlook-message-status-unavailable");
        for (const value of leakedValues) assert.doesNotMatch(String(error), new RegExp(value));
        return true;
      },
    );
  });

  it("preserves an already-redacted Outlook reconciliation code", async () => {
    const { adapter } = adapterFor(
      new OutlookReconciliationError("outlook-graph-authorization-failed"),
    );

    await assert.rejects(
      adapter.reconcile(REFERENCE, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof OutlookReconciliationError);
        assert.equal(error.code, "outlook-graph-authorization-failed");
        assert.equal(error.message, "outlook-graph-authorization-failed");
        return true;
      },
    );
  });

  it("produces deterministic digests that change with terminal status", async () => {
    const sent = {
      status: "found" as const,
      immutableMessageId: "immutable-message-1",
      isDraft: false,
      sentDateTime: "2026-07-28T00:00:00.000Z",
      internetMessageId: "<quote-1@example.invalid>",
    };
    const first = await adapterFor(sent).adapter.reconcile(REFERENCE, new AbortController().signal);
    const second = await adapterFor(sent).adapter.reconcile(
      REFERENCE,
      new AbortController().signal,
    );
    const changed = await adapterFor({
      ...sent,
      sentDateTime: "2026-07-28T00:00:01.000Z",
    }).adapter.reconcile(REFERENCE, new AbortController().signal);

    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "succeeded");
    assert.equal(changed.status, "succeeded");
    if (
      first.status !== "succeeded" ||
      second.status !== "succeeded" ||
      changed.status !== "succeeded"
    ) {
      assert.fail("Expected terminal Outlook statuses.");
    }
    assert.equal(first.outputDigest, second.outputDigest);
    assert.notEqual(first.outputDigest, changed.outputDigest);
  });
});
