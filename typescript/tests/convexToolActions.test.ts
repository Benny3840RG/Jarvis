import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexToolActionService } from "../src/persistence/convexToolActions.js";

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
});
