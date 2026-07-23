import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolExecutionReceipt } from "../src/actions/toolExecution.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexToolExecutionReceiptStore } from "../src/persistence/convexToolExecutionReceipts.js";

function receiptRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    receiptKey: "action-1:exec-1",
    receiptId: "a1b2c3d4e5f6",
    actionId: "action-1",
    idempotencyKey: "exec-1",
    tool: "calendar",
    operation: "create_event",
    status: "succeeded",
    outputDigest: "deadbeef",
    startedAt: 1_784_073_600_000,
    completedAt: 1_784_073_600_500,
    ...overrides,
  };
}

describe("ConvexToolExecutionReceiptStore", () => {
  it("maps a stored receipt without conflating receiptId with the lookup key", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return receiptRow();
      },
      async mutation() {
        throw new Error("mutation must not be called by get()");
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexToolExecutionReceiptStore(client, "service-token");

    const receipt = await store.get("action-1:exec-1");

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      receiptKey: "action-1:exec-1",
    });
    assert.equal(receipt?.receiptId, "a1b2c3d4e5f6");
    assert.notEqual(receipt?.receiptId, "action-1:exec-1");
    assert.equal(receipt?.startedAt, "2026-07-15T00:00:00.000Z");
    assert.equal(receipt?.completedAt, "2026-07-15T00:00:00.500Z");
  });

  it("returns null when no receipt exists for the key", async () => {
    const client = {
      async query() {
        return null;
      },
      async mutation() {
        throw new Error("mutation must not be called by get()");
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexToolExecutionReceiptStore(client, "service-token");

    assert.equal(await store.get("missing-key"), null);
  });

  it("saves a receipt, preserving its own receiptId separately from the lookup key", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query() {
        throw new Error("query must not be called by save()");
      },
      async mutation(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return receiptRow();
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexToolExecutionReceiptStore(client, "service-token");

    const receipt: ToolExecutionReceipt = {
      receiptId: "a1b2c3d4e5f6",
      actionId: "action-1",
      idempotencyKey: "exec-1",
      tool: "calendar",
      operation: "create_event",
      status: "succeeded",
      outputDigest: "deadbeef",
      startedAt: "2026-07-15T00:00:00.000Z",
      completedAt: "2026-07-15T00:00:00.500Z",
    };
    await store.save("action-1:exec-1", receipt);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      receiptKey: "action-1:exec-1",
      receiptId: "a1b2c3d4e5f6",
      actionId: "action-1",
      idempotencyKey: "exec-1",
      tool: "calendar",
      operation: "create_event",
      status: "succeeded",
      outputDigest: "deadbeef",
      startedAt: 1_784_073_600_000,
      completedAt: 1_784_073_600_500,
    });
  });

  it("omits optional fields rather than sending them as undefined", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query() {
        throw new Error("query must not be called by save()");
      },
      async mutation(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return receiptRow({
          status: "blocked",
          outputDigest: undefined,
          errorCode: "not-allowlisted",
        });
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexToolExecutionReceiptStore(client, "service-token");

    const receipt: ToolExecutionReceipt = {
      receiptId: "a1b2c3d4e5f6",
      actionId: "action-1",
      idempotencyKey: "exec-1",
      tool: "calendar",
      operation: "create_event",
      status: "blocked",
      errorCode: "not-allowlisted",
      startedAt: "2026-07-15T00:00:00.000Z",
      completedAt: "2026-07-15T00:00:00.500Z",
    };
    await store.save("action-1:exec-1", receipt);

    const sentArgs = calls[0]?.args as Record<string, unknown>;
    assert.equal("outputDigest" in sentArgs, false);
    assert.equal(sentArgs.errorCode, "not-allowlisted");
  });
});
