import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolAction } from "../src/actions/toolActions.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import {
  ConvexSingleUseConsumptionClaimStore,
  ConvexToolActionService,
} from "../src/persistence/convexToolActions.js";

function actionRow(state = "proposed") {
  return {
    actionId: "action-1",
    requestId: "request-1",
    projectKey: "project-1",
    baseRevision: 3,
    state,
    tool: "calendar",
    operation: "create_event",
    arguments: { durationMinutes: 30, title: "Inspect bracket" },
    rationale: "Schedule the approved inspection.",
    requiredAuthority: "T2",
    destructive: false,
    idempotencyKey: "request-1:create-event",
    proposedBy: "agent",
    createdAt: 1_784_073_600_000,
    updatedAt: 1_784_073_600_000,
  };
}

describe("ConvexToolActionService", () => {
  it("stages through one authenticated mutation and maps the result", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query() {
        return null;
      },
      async mutation(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return actionRow();
      },
    } as unknown as ConvexClientLike;
    const service = new ConvexToolActionService(client, "service-token");

    const result = await service.stage({
      actionId: "action-1",
      requestId: "request-1",
      projectId: "project-1",
      expectedRevision: 3,
      tool: "calendar",
      operation: "create_event",
      arguments: { durationMinutes: 30, title: "Inspect bracket" },
      rationale: "Schedule the approved inspection.",
      requiredAuthority: "T2",
      destructive: false,
      idempotencyKey: "request-1:create-event",
      proposedBy: "agent",
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      actionId: "action-1",
      requestId: "request-1",
      projectKey: "project-1",
      expectedRevision: 3,
      tool: "calendar",
      operation: "create_event",
      arguments: { durationMinutes: 30, title: "Inspect bracket" },
      rationale: "Schedule the approved inspection.",
      requiredAuthority: "T2",
      destructive: false,
      idempotencyKey: "request-1:create-event",
      proposedBy: "agent",
    });
    assert.equal(result.projectId, "project-1");
    assert.equal(result.state, "proposed");
    assert.equal(result.createdAt, "2026-07-15T00:00:00.000Z");
  });

  it("maps approval metadata and query results", async () => {
    const client = {
      async query() {
        return [
          {
            ...actionRow("approved"),
            approvedBy: "user",
            approvedAt: 1_784_073_601_000,
            updatedAt: 1_784_073_601_000,
          },
        ];
      },
      async mutation() {
        return {
          ...actionRow("approved"),
          approvedBy: "user",
          approvedAt: 1_784_073_601_000,
          updatedAt: 1_784_073_601_000,
        };
      },
    } as unknown as ConvexClientLike;
    const service = new ConvexToolActionService(client, "service-token");

    const approved = await service.approve({
      actionId: "action-1",
      projectId: "project-1",
      expectedRevision: 3,
    });
    const listed = await service.list({ projectId: "project-1", state: "approved", limit: 5 });

    assert.equal(approved.state, "approved");
    assert.equal(approved.approvedBy, "user");
    assert.equal(approved.approvedAt, "2026-07-15T00:00:01.000Z");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.actionId, "action-1");
  });

  it("revokes through one authenticated mutation and maps revocation metadata", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query() {
        return null;
      },
      async mutation(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return {
          ...actionRow("revoked"),
          revokedBy: "user",
          revokedReason: "Pricing changed after approval.",
          revokedAt: 1_784_073_602_000,
          updatedAt: 1_784_073_602_000,
        };
      },
    } as unknown as ConvexClientLike;
    const service = new ConvexToolActionService(client, "service-token");

    const revoked = await service.revoke({
      actionId: "action-1",
      projectId: "project-1",
      reason: "Pricing changed after approval.",
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      projectKey: "project-1",
      actionId: "action-1",
      reason: "Pricing changed after approval.",
    });
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.revokedBy, "user");
    assert.equal(revoked.revokedReason, "Pricing changed after approval.");
    assert.equal(revoked.revokedAt, "2026-07-15T00:00:02.000Z");
  });

  it("maps consent-lifecycle fields (expiry policy, consumption policy) when present", async () => {
    const client = {
      async query() {
        return {
          ...actionRow("approved"),
          approvalExpiryPolicy: "ttl",
          approvalExpiresAt: 1_784_073_601_000,
          consumptionPolicy: "reusable",
          isApprovalExpired: false,
        };
      },
      async mutation() {
        throw new Error("mutation must not be called by get()");
      },
    } as unknown as ConvexClientLike;
    const service = new ConvexToolActionService(client, "service-token");

    const result = await service.get({ actionId: "action-1", projectId: "project-1" });

    assert.equal(result?.approvalExpiryPolicy, "ttl");
    assert.equal(result?.approvalExpiresAt, "2026-07-15T00:00:01.000Z");
    assert.equal(result?.consumptionPolicy, "reusable");
    assert.equal(result?.isApprovalExpired, false);
  });
});

describe("ConvexSingleUseConsumptionClaimStore", () => {
  it("claims through one authenticated mutation, scoped by project and action", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query() {
        throw new Error("query must not be called by claim()");
      },
      async mutation(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return { claimed: true, claimId: "claim-a" };
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexSingleUseConsumptionClaimStore(client, "service-token");
    const action = { actionId: "action-1", projectId: "project-1" } as ToolAction;

    const result = await store.claim(action, "claim-a");

    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      projectKey: "project-1",
      actionId: "action-1",
      claimId: "claim-a",
    });
    assert.deepEqual(result, { claimed: true, claimId: "claim-a" });
  });

  it("surfaces the authoritative loser result unchanged when another claim already won", async () => {
    const client = {
      async query() {
        throw new Error("query must not be called by claim()");
      },
      async mutation() {
        return { claimed: false, claimId: "claim-a" };
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexSingleUseConsumptionClaimStore(client, "service-token");
    const action = { actionId: "action-1", projectId: "project-1" } as ToolAction;

    const result = await store.claim(action, "claim-b");

    assert.deepEqual(result, { claimed: false, claimId: "claim-a" });
  });

  it("passes through a not-approved or expired block reason unchanged", async () => {
    const client = {
      async query() {
        throw new Error("query must not be called by claim()");
      },
      async mutation() {
        return { claimed: false, claimId: "", blockReason: "expired" };
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexSingleUseConsumptionClaimStore(client, "service-token");
    const action = { actionId: "action-1", projectId: "project-1" } as ToolAction;

    const result = await store.claim(action, "claim-a");

    assert.deepEqual(result, { claimed: false, claimId: "", blockReason: "expired" });
  });
});
