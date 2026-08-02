import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolExecutionReceipt } from "../src/actions/toolExecution.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexToolExecutionReceiptStore } from "../src/persistence/convexToolExecutionReceipts.js";

describe("ConvexToolExecutionReceiptStore external metadata", () => {
  it("preserves effect and reconciliation metadata across save and reload", async () => {
    let stored: Record<string, unknown> | null = null;
    const client = {
      async query() {
        return stored;
      },
      async mutation(_functionRef: unknown, args: unknown) {
        stored = args as Record<string, unknown>;
        return stored;
      },
    } as unknown as ConvexClientLike;

    const store = new ConvexToolExecutionReceiptStore(client, "service-token");
    const receipt: ToolExecutionReceipt = {
      receiptId: "receipt-1",
      actionId: "action-1",
      requestId: "request-1",
      projectId: "project-1",
      idempotencyKey: "execution-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:action",
      effectFingerprint: "jarvis-effect-fingerprint:v1:effect",
      tool: "quotes",
      operation: "send",
      actor: "agent",
      approvalId: "approval-1",
      policyVersion: "totality-policy:v2.2",
      correlationId: "correlation-1",
      source: "external-metadata-test",
      provider: "email-provider",
      providerRequestId: "provider-request-1",
      providerCorrelationId: "provider-correlation-1",
      reconciliationId: "reconciliation-1",
      status: "indeterminate",
      errorCode: "indeterminate",
      providerErrorCode: "provider-timeout",
      startedAt: "2026-07-27T00:00:00.000Z",
      completedAt: "2026-07-27T00:00:05.000Z",
    };

    await store.save("external:project-1:execution-1", receipt);
    const reloaded = await store.get("external:project-1:execution-1");

    assert.equal(reloaded?.effectFingerprint, receipt.effectFingerprint);
    assert.equal(reloaded?.provider, receipt.provider);
    assert.equal(reloaded?.providerRequestId, receipt.providerRequestId);
    assert.equal(reloaded?.providerCorrelationId, receipt.providerCorrelationId);
    assert.equal(reloaded?.reconciliationId, receipt.reconciliationId);
    assert.equal(reloaded?.providerErrorCode, receipt.providerErrorCode);
  });
});
