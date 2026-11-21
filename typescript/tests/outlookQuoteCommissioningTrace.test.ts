import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { commissioningTrace } from "../src/tools/runOutlookQuoteCommissioning.js";

const MESSAGE = "AAkALgAAimmutable";

describe("Outlook commissioning trace (#866)", () => {
  it("keeps the repeat receipt, the delivery timeline, the reconciliation history and every worker run", () => {
    const trace = commissioningTrace({
      repeatReceipt: {
        receiptId: "r-repeat",
        actionId: "m-repeat",
        status: "blocked",
        errorCode: "quote-delivery-duplicate",
        startedAt: "2026-11-21T00:00:01.000Z",
        completedAt: "2026-11-21T00:00:01.100Z",
        education: "ignored",
      },
      deliveries: {
        data: [
          {
            deliveryAttemptId: "d-1",
            status: "reconciled",
            reconciledOutcome: "succeeded",
            providerRequestId: MESSAGE,
            recipient: "owner@example.com",
            createdAt: 1,
            executionStartedAt: 2,
            reconciledAt: 4,
          },
        ],
      },
      reconciliationDetail: {
        reconciliation: {
          reconciliationId: "rec-1",
          providerRequestId: MESSAGE,
          state: "resolved",
          terminalStatus: "succeeded",
          attemptCount: 2,
          lastErrorCode: "outlook-message-still-draft",
          createdAt: 3,
          resolvedAt: 4,
        },
      },
      workers: [
        { workerId: "first-seq-0", result: { status: "released" } },
        { workerId: "first-par-a", result: { status: "idle" } },
        { workerId: "first-par-b", result: { status: "idle" } },
      ],
    });

    assert.deepEqual(trace.repeatSend, {
      receiptId: "r-repeat",
      status: "blocked",
      errorCode: "quote-delivery-duplicate",
      startedAt: "2026-11-21T00:00:01.000Z",
      completedAt: "2026-11-21T00:00:01.100Z",
    });
    // The recipient is already in the evidence; the trace does not repeat it.
    assert.deepEqual(trace.deliveries, [
      {
        deliveryAttemptId: "d-1",
        status: "reconciled",
        reconciledOutcome: "succeeded",
        providerRequestId: MESSAGE,
        createdAt: 1,
        executionStartedAt: 2,
        reconciledAt: 4,
      },
    ]);
    assert.equal(trace.reconciliation?.attemptCount, 2);
    assert.equal(trace.reconciliation?.lastErrorCode, "outlook-message-still-draft");
    // The draft and the sent item were observed under one Graph id.
    assert.equal(trace.sameMessageIdDraftToSent, true);
    assert.deepEqual(
      trace.workers.map((worker) => [worker.workerId, worker.result.status]),
      [
        ["first-seq-0", "released"],
        ["first-par-a", "idle"],
        ["first-par-b", "idle"],
      ],
    );
  });

  it("reports a missing receipt or record as absent, never as a pass", () => {
    const trace = commissioningTrace({
      repeatReceipt: null,
      deliveries: {},
      reconciliationDetail: null,
      workers: [],
    });
    assert.equal(trace.repeatSend, null);
    assert.deepEqual(trace.deliveries, []);
    assert.equal(trace.reconciliation, null);
    assert.equal(trace.sameMessageIdDraftToSent, false);
  });
});
