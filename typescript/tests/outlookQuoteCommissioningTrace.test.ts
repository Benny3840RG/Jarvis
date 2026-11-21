import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commissioningTrace,
  drainWorker,
  type CommissioningWorkerRun,
} from "../src/tools/runOutlookQuoteCommissioning.js";

describe("Outlook commissioning worker drain", () => {
  it("starts the parallel pair together before any sequential run", async () => {
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const worker = {
      async runOnce(input: { workerId: string }) {
        started.push(input.workerId);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return { status: "idle" as const };
      },
    };
    const runs: CommissioningWorkerRun[] = [];
    await drainWorker(worker as never, "m", runs);
    assert.deepEqual(started, ["m-par-a", "m-par-b", "m-seq-0", "m-seq-1", "m-seq-2"]);
    assert.equal(maxInFlight, 2);
    assert.deepEqual(
      runs.map((run) => run.workerId),
      ["m-par-a", "m-par-b", "m-seq-0", "m-seq-1", "m-seq-2"],
    );
  });
});

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

  it("keeps each delivery's transition history and reads the immutable-id confirmation from it", () => {
    const trace = commissioningTrace({
      repeatReceipt: null,
      deliveries: {
        data: [
          {
            deliveryAttemptId: "d-1",
            status: "reconciled",
            providerRequestId: MESSAGE,
            transitions: [
              { event: "pending", at: 1 },
              { event: "executing", at: 2 },
              { event: "provider-reference", at: 3, immutableIdApplied: true },
              { event: "indeterminate", at: 4 },
              { event: "reconciled", at: 5, note: "ignored" },
              "not-an-entry",
            ],
          },
        ],
      },
      reconciliationDetail: {
        reconciliation: {
          reconciliationId: "rec-1",
          providerRequestId: MESSAGE,
          state: "resolved",
        },
      },
      workers: [],
    });
    assert.deepEqual(trace.deliveries[0]?.transitions, [
      { event: "pending", at: 1 },
      { event: "executing", at: 2 },
      { event: "provider-reference", at: 3, immutableIdApplied: true },
      { event: "indeterminate", at: 4 },
      { event: "reconciled", at: 5 },
    ]);
    assert.equal(trace.draftImmutableIdApplied, true);
  });

  it("does not credit the immutable-id confirmation from a different delivery or a false flag", () => {
    const withFlag = (providerRequestId: string, immutableIdApplied: boolean) =>
      commissioningTrace({
        repeatReceipt: null,
        deliveries: {
          data: [
            {
              deliveryAttemptId: "d-1",
              providerRequestId,
              transitions: [{ event: "provider-reference", at: 3, immutableIdApplied }],
            },
          ],
        },
        reconciliationDetail: { reconciliation: { providerRequestId: MESSAGE } },
        workers: [],
      }).draftImmutableIdApplied;
    assert.equal(withFlag("another-message", true), false);
    assert.equal(withFlag(MESSAGE, false), false);
  });

  it("records whether the parallel pair raced before anything resolved, and how many runs resolved", () => {
    const raced = commissioningTrace({
      repeatReceipt: null,
      deliveries: {},
      reconciliationDetail: null,
      workers: [
        { workerId: "first-par-a", result: { status: "resolved" } },
        { workerId: "first-par-b", result: { status: "idle" } },
        { workerId: "first-seq-0", result: { status: "idle" } },
      ],
    });
    assert.equal(raced.parallelRaceBeforeResolution, true);
    assert.equal(raced.resolvedWorkerRuns, 1);

    const late = commissioningTrace({
      repeatReceipt: null,
      deliveries: {},
      reconciliationDetail: null,
      workers: [
        { workerId: "first-seq-0", result: { status: "resolved" } },
        { workerId: "first-par-a", result: { status: "idle" } },
        { workerId: "first-par-b", result: { status: "idle" } },
      ],
    });
    assert.equal(late.parallelRaceBeforeResolution, false);
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
    assert.equal(trace.draftImmutableIdApplied, false);
    assert.equal(trace.parallelRaceBeforeResolution, false);
    assert.equal(trace.resolvedWorkerRuns, 0);
  });
});
