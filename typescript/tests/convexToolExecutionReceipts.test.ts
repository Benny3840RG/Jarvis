import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolExecutionReceipt } from "../src/actions/toolExecution.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexToolExecutionReceiptStore } from "../src/persistence/convexToolExecutionReceipts.js";

function receiptRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    receiptKey: "project-1:action-1:exec-1",
    receiptId: "a1b2c3d4e5f6",
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    idempotencyKey: "exec-1",
    actionFingerprint: "jarvis-action-fingerprint:v1:fingerprint-1",
    tool: "calendar",
    operation: "create_event",
    actor: "agent",
    approvalId: "approval-1",
    policyVersion: "totality-policy:v2.2",
    correlationId: "correlation-1",
    source: "commissioning-test",
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

    const receipt = await store.get("project-1:action-1:exec-1");

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      receiptKey: "project-1:action-1:exec-1",
    });
    assert.equal(receipt?.receiptId, "a1b2c3d4e5f6");
    assert.notEqual(receipt?.receiptId, "project-1:action-1:exec-1");
    assert.equal(receipt?.requestId, "request-1");
    assert.equal(receipt?.projectId, "project-1");
    assert.equal(receipt?.actor, "agent");
    assert.equal(receipt?.approvalId, "approval-1");
    assert.equal(receipt?.policyVersion, "totality-policy:v2.2");
    assert.equal(receipt?.correlationId, "correlation-1");
    assert.equal(receipt?.source, "commissioning-test");
    assert.equal(receipt?.actionFingerprint, "jarvis-action-fingerprint:v1:fingerprint-1");
    assert.equal(receipt?.startedAt, "2026-07-15T00:00:00.000Z");
    assert.equal(receipt?.completedAt, "2026-07-15T00:00:00.500Z");
  });

  it("maps legacy rows with explicit conservative metadata fallbacks", async () => {
    const client = {
      async query() {
        return receiptRow({
          requestId: undefined,
          actor: undefined,
          approvalId: undefined,
          policyVersion: undefined,
          correlationId: undefined,
          source: undefined,
        });
      },
      async mutation() {
        throw new Error("mutation must not be called by get()");
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexToolExecutionReceiptStore(client, "service-token");

    const receipt = await store.get("legacy-key");

    assert.equal(receipt?.requestId, "action-1");
    assert.equal(receipt?.actor, "tool");
    assert.equal(receipt?.approvalId, undefined);
    assert.equal(receipt?.policyVersion, "legacy-unversioned");
    assert.equal(receipt?.correlationId, "action-1");
    assert.equal(receipt?.source, "legacy-tool-execution-receipt");
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

  it("lists every receipt recorded for an action, independent of idempotency key", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return [
          receiptRow({ receiptKey: "project-1:action-1:exec-1", idempotencyKey: "exec-1" }),
          receiptRow({
            receiptKey: "project-1:action-1:exec-2",
            idempotencyKey: "exec-2",
            status: "failed",
          }),
        ];
      },
      async mutation() {
        throw new Error("mutation must not be called by listReceiptsForAction()");
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexToolExecutionReceiptStore(client, "service-token");

    const receipts = await store.listReceiptsForAction("action-1");

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, { serviceToken: "service-token", actionId: "action-1" });
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0]?.idempotencyKey, "exec-1");
    assert.equal(receipts[1]?.idempotencyKey, "exec-2");
    assert.equal(receipts[1]?.status, "failed");
  });

  it("saves a receipt with project, fingerprint and audit metadata", async () => {
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
      requestId: "request-1",
      projectId: "project-1",
      idempotencyKey: "exec-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:fingerprint-1",
      tool: "calendar",
      operation: "create_event",
      actor: "agent",
      approvalId: "approval-1",
      policyVersion: "totality-policy:v2.2",
      correlationId: "correlation-1",
      source: "commissioning-test",
      status: "succeeded",
      outputDigest: "deadbeef",
      startedAt: "2026-07-15T00:00:00.000Z",
      completedAt: "2026-07-15T00:00:00.500Z",
    };
    await store.save("project-1:action-1:exec-1", receipt);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      receiptKey: "project-1:action-1:exec-1",
      receiptId: "a1b2c3d4e5f6",
      actionId: "action-1",
      requestId: "request-1",
      projectId: "project-1",
      idempotencyKey: "exec-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:fingerprint-1",
      tool: "calendar",
      operation: "create_event",
      actor: "agent",
      approvalId: "approval-1",
      policyVersion: "totality-policy:v2.2",
      correlationId: "correlation-1",
      source: "commissioning-test",
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
          approvalId: undefined,
          outputDigest: undefined,
          errorCode: "not-allowlisted",
        });
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexToolExecutionReceiptStore(client, "service-token");

    const receipt: ToolExecutionReceipt = {
      receiptId: "a1b2c3d4e5f6",
      actionId: "action-1",
      requestId: "request-1",
      projectId: "project-1",
      idempotencyKey: "exec-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:fingerprint-1",
      tool: "calendar",
      operation: "create_event",
      actor: "agent",
      policyVersion: "totality-policy:v2.2",
      correlationId: "correlation-1",
      source: "commissioning-test",
      status: "blocked",
      errorCode: "not-allowlisted",
      startedAt: "2026-07-15T00:00:00.000Z",
      completedAt: "2026-07-15T00:00:00.500Z",
    };
    await store.save("project-1:action-1:exec-1", receipt);

    const sentArgs = calls[0]?.args as Record<string, unknown>;
    assert.equal("approvalId" in sentArgs, false);
    assert.equal("outputDigest" in sentArgs, false);
    assert.equal(sentArgs.errorCode, "not-allowlisted");
  });
});
