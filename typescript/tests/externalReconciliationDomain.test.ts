import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  externalExecutionScopeKey,
  providerReferenceFromRecord,
  type ExternalReconciliationRecord,
} from "../src/reconciliation/externalReconciliation.js";

function record(overrides: Partial<ExternalReconciliationRecord> = {}): ExternalReconciliationRecord {
  return {
    reconciliationId: "reconciliation-1",
    executionKey: "execution-1",
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    idempotencyKey: "send-key-1",
    actionFingerprint: "jarvis-action-fingerprint:v1:action",
    effectFingerprint: "jarvis-effect-fingerprint:v1:effect",
    tool: "quotes",
    operation: "send",
    provider: "email-provider",
    providerRequestId: "provider-request-1",
    providerCorrelationId: "provider-correlation-1",
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: 100,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe("external reconciliation domain", () => {
  it("builds an unambiguous scope key independent of action identity", () => {
    const first = externalExecutionScopeKey({
      projectId: "project:one",
      tool: "quotes",
      operation: "send",
      idempotencyKey: "key|one",
    });
    const duplicate = externalExecutionScopeKey({
      projectId: "project:one",
      tool: "quotes",
      operation: "send",
      idempotencyKey: "key|one",
    });
    const changed = externalExecutionScopeKey({
      projectId: "project:one",
      tool: "quotes",
      operation: "send",
      idempotencyKey: "key|two",
    });

    assert.equal(first, duplicate);
    assert.notEqual(first, changed);
    assert.equal(first, "11:project:one|6:quotes|4:send|7:key|one");
  });

  it("returns a provider reference only when the durable request id exists", () => {
    assert.deepEqual(providerReferenceFromRecord(record()), {
      provider: "email-provider",
      providerRequestId: "provider-request-1",
      providerCorrelationId: "provider-correlation-1",
    });
    assert.equal(providerReferenceFromRecord(record({ providerRequestId: undefined })), null);
  });
});
