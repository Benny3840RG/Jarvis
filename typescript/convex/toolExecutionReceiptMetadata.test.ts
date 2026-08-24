import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { bindSafety } from "../src/safety/safetyBinder.js";
import { toConvexSafetyBinding } from "./safetyBindingValidators.js";

const SERVICE_TOKEN = "receipt-metadata-service-token-00000000000";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tool execution receipt metadata", () => {
  it("persists external effect and reconciliation fields", async () => {
    const t = harness();
    const input = {
      serviceToken: SERVICE_TOKEN,
      receiptKey: "external:project-1:execution-1",
      receiptId: "receipt-1",
      actionId: "action-1",
      requestId: "request-1",
      projectId: "project-1",
      idempotencyKey: "execution-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:action",
      effectFingerprint: "jarvis-effect-fingerprint:v1:effect",
      tool: "quotes",
      operation: "send",
      actor: "agent" as const,
      approvalId: "approval-1",
      policyVersion: "totality-policy:v2.2",
      correlationId: "correlation-1",
      source: "convex-receipt-test",
      provider: "email-provider",
      providerRequestId: "provider-request-1",
      providerCorrelationId: "provider-correlation-1",
      reconciliationId: "reconciliation-1",
      status: "indeterminate" as const,
      errorCode: "indeterminate" as const,
      providerErrorCode: "provider-timeout",
      safetyBinding: toConvexSafetyBinding(
        bindSafety({
          phase: "tool-execute",
          riskLevel: "moderate",
          reliabilityHealthy: true,
          proposalSafe: true,
          toolAllowlisted: true,
          requiredAuthority: "T1",
          grantedAuthority: "T1",
          actionState: "execute",
          requiresApproval: true,
          approvalPresent: true,
          idempotencyKey: "execution-1",
          correlationId: "correlation-1",
          stateValid: true,
        }),
      ),
      startedAt: 1,
      completedAt: 2,
    };

    const saved = await t.mutation(api.toolExecutionReceipts.save, input);
    const loaded = await t.query(api.toolExecutionReceipts.get, {
      serviceToken: SERVICE_TOKEN,
      receiptKey: input.receiptKey,
    });

    expect(saved.effectFingerprint).toBe(input.effectFingerprint);
    expect(loaded?.provider).toBe(input.provider);
    expect(loaded?.providerRequestId).toBe(input.providerRequestId);
    expect(loaded?.providerCorrelationId).toBe(input.providerCorrelationId);
    expect(loaded?.reconciliationId).toBe(input.reconciliationId);
    expect(loaded?.providerErrorCode).toBe(input.providerErrorCode);
    expect(loaded?.safetyBinding?.version).toBe("jarvis-safety-binding:v1");
    expect(loaded?.safetyBinding?.phase).toBe("tool-execute");
  });

  it("lists receipts by action ID without mixing other actions", async () => {
    const t = harness();
    const base = {
      serviceToken: SERVICE_TOKEN,
      requestId: "request-1",
      projectId: "project-1",
      actionFingerprint: "jarvis-action-fingerprint:v1:action",
      tool: "notes",
      operation: "create",
      actor: "agent" as const,
      policyVersion: "totality-policy:v2.2",
      correlationId: "correlation-1",
      source: "convex-receipt-list-test",
      startedAt: 1,
      completedAt: 2,
    };
    await t.mutation(api.toolExecutionReceipts.save, {
      ...base,
      receiptKey: "live:action-1",
      receiptId: "live-1",
      actionId: "action-1",
      idempotencyKey: "tool-action-execution:v1:live:one",
      status: "succeeded",
    });
    await t.mutation(api.toolExecutionReceipts.save, {
      ...base,
      receiptKey: "dry:action-1",
      receiptId: "dry-1",
      actionId: "action-1",
      idempotencyKey: "tool-action-execution:v1:dry-run:one",
      status: "dry-run",
    });
    await t.mutation(api.toolExecutionReceipts.save, {
      ...base,
      receiptKey: "live:action-2",
      receiptId: "live-2",
      actionId: "action-2",
      idempotencyKey: "tool-action-execution:v1:live:two",
      status: "succeeded",
    });

    const listed = await t.query(api.toolExecutionReceipts.listByActionId, {
      serviceToken: SERVICE_TOKEN,
      actionId: "action-1",
    });
    expect(listed.map((row) => row.receiptId).sort()).toEqual(["dry-1", "live-1"]);
  });
});
