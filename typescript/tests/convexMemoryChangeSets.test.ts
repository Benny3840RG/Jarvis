import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexMemoryChangeSetService } from "../src/persistence/convexMemoryChangeSets.js";

function changeSetRow(state = "proposed") {
  return {
    changeSetId: "change-1",
    requestId: "request-1",
    projectKey: "project-1",
    baseRevision: 3,
    state,
    records: [
      {
        kind: "fact",
        recordId: "fact-1",
        statement: "Bracket thickness is 6 mm.",
        source: "measurement",
        confidence: 1,
        recordedAt: "2026-07-15T00:00:00.000Z",
      },
    ],
    rationale: "Record the verified measurement.",
    proposedBy: "user",
    createdAt: 1_784_073_600_000,
    updatedAt: 1_784_073_600_000,
  };
}

describe("ConvexMemoryChangeSetService", () => {
  it("stages through one authenticated Convex mutation and maps the result", async () => {
    const calls: Array<{ args: unknown }> = [];
    const client = {
      async query() {
        return null;
      },
      async mutation(_functionRef: unknown, args: unknown) {
        calls.push({ args });
        return changeSetRow();
      },
    } as unknown as ConvexClientLike;
    const service = new ConvexMemoryChangeSetService(client, "service-token");

    const result = await service.stage({
      changeSetId: "change-1",
      requestId: "request-1",
      projectId: "project-1",
      expectedRevision: 3,
      records: changeSetRow().records as never,
      rationale: "Record the verified measurement.",
      proposedBy: "user",
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      changeSetId: "change-1",
      requestId: "request-1",
      projectKey: "project-1",
      expectedRevision: 3,
      records: changeSetRow().records,
      rationale: "Record the verified measurement.",
      proposedBy: "user",
    });
    assert.equal(result.projectId, "project-1");
    assert.equal(result.createdAt, "2026-07-15T00:00:00.000Z");
  });

  it("maps the atomic apply result and preserves idempotency", async () => {
    const client = {
      async query() {
        return null;
      },
      async mutation() {
        return {
          changeSet: {
            ...changeSetRow("applied"),
            appliedAt: 1_784_073_601_000,
            appliedRevision: 4,
          },
          project: { revision: 5 },
          records: [
            {
              recordId: "fact-1",
              projectKey: "project-1",
              kind: "fact",
              record: changeSetRow().records[0],
              updatedAt: 1_784_073_601_000,
            },
          ],
          idempotent: true,
        };
      },
    } as unknown as ConvexClientLike;
    const service = new ConvexMemoryChangeSetService(client, "service-token");

    const result = await service.apply({ changeSetId: "change-1", expectedRevision: 3 });

    assert.equal(result.changeSet.state, "applied");
    assert.equal(result.changeSet.appliedRevision, 4);
    assert.equal(result.projectRevision, 5);
    assert.equal(result.records[0]?.recordId, "fact-1");
    assert.equal(result.idempotent, true);
  });
});
