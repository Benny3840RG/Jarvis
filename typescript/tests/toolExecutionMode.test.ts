import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveToolExecutionIdempotencyKey,
  executionModeFromReceipt,
  selectLiveReceipt,
  type ToolExecutionReceipt,
} from "../src/actions/toolExecution.js";

function receipt(
  mode: "live" | "dry-run",
  status: ToolExecutionReceipt["status"],
): ToolExecutionReceipt {
  return {
    receiptId: `${mode}-${status}`,
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    idempotencyKey: deriveToolExecutionIdempotencyKey("action-1", mode),
    actionFingerprint: "fp",
    tool: "notes",
    operation: "create",
    actor: "agent",
    policyVersion: "totality-policy:v2.2",
    correlationId: "c1",
    source: "mode-test",
    status,
    startedAt: "2026-08-23T00:00:00.000Z",
    completedAt: "2026-08-23T00:00:01.000Z",
  };
}

describe("tool execution mode identity", () => {
  it("keeps live and dry-run idempotency keys distinct", () => {
    const live = deriveToolExecutionIdempotencyKey("action-1", "live");
    const dry = deriveToolExecutionIdempotencyKey("action-1", "dry-run");
    assert.notEqual(live, dry);
    assert.match(live, /:live:/);
    assert.match(dry, /:dry-run:/);
  });

  it("never selects a dry-run success as the live receipt", () => {
    const dry = receipt("dry-run", "dry-run");
    const liveFailed = receipt("live", "failed");
    assert.equal(executionModeFromReceipt(dry), "dry-run");
    assert.equal(selectLiveReceipt([dry]), null);
    assert.equal(selectLiveReceipt([dry, liveFailed])?.status, "failed");
  });
});
