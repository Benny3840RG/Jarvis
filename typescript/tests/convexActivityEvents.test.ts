import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexActivityEventReader } from "../src/persistence/convexActivityEvents.js";

function auditEventRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "audit-1",
    ownerId: "jarvis-cli",
    scopeKey: "project-1",
    eventType: "tool.action.proposed",
    actor: "agent",
    payload: { actionId: "action-1" },
    createdAt: 1_784_073_600_000,
    ...overrides,
  };
}

describe("ConvexActivityEventReader", () => {
  it("queries through one authenticated call and maps the pagination result", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return { page: [auditEventRow()], continueCursor: "next-cursor", isDone: false };
      },
      async mutation() {
        throw new Error("must not be called");
      },
    } as unknown as ConvexClientLike;
    const reader = new ConvexActivityEventReader(client, "service-token");

    const result = await reader.listActivityPage({ cursor: null, limit: 10 });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.activityId, "audit-1");
    assert.equal(result.events[0]?.projectKey, "project-1");
    assert.equal(result.continueCursor, "next-cursor");
    assert.equal(result.isDone, false);
  });

  it("omits projectKey for events recorded under the global scope sentinel", async () => {
    const client = {
      async query() {
        return {
          page: [auditEventRow({ scopeKey: "__global__" })],
          continueCursor: "",
          isDone: true,
        };
      },
      async mutation() {
        throw new Error("must not be called");
      },
    } as unknown as ConvexClientLike;
    const reader = new ConvexActivityEventReader(client, "service-token");

    const result = await reader.listActivityPage({ cursor: null, limit: 10 });

    assert.equal("projectKey" in result.events[0]!, false);
  });

  it("requires a service token", () => {
    assert.throws(
      () => new ConvexActivityEventReader({} as ConvexClientLike, undefined),
      /JARVIS_SERVICE_TOKEN/,
    );
  });
});
