import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConvexError } from "convex/values";

import { ConvexDevelopmentLiveWorkSource } from "../src/persistence/convexDevelopmentLiveWork.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { readLiveWorkPipeline } from "../src/development/liveWork.js";

function snapshot() {
  return {
    subject: {
      subjectId: "mission",
      state: "BUILDING",
      updatedAt: 1000,
      subjectVersion: 2,
      fencingToken: 1,
    },
    events: [
      {
        eventId: "e1",
        eventType: "DEV_TRANSITION_COMMITTED",
        occurredAt: "2026-09-01T00:00:00.000Z",
        from: "CLAIMED",
        to: "BUILDING",
        reasonCodes: [],
        hasMergeReceipt: false,
      },
    ],
    omegaMission: null,
    workerStep: null,
    omegaReadiness: { allowed: false, failures: ["residual-uncertainty-not-recorded"] },
    generatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function source(value: unknown) {
  const client: ConvexClientLike = {
    query: async () => value,
    mutation: async () => {
      throw new Error("Unexpected mutation");
    },
  };
  return new ConvexDevelopmentLiveWorkSource(client, "test-token");
}

describe("Convex live-work projection validation", () => {
  it("preserves null idle and validates a well-formed snapshot", async () => {
    assert.equal(await source(null).readLiveWorkSnapshot(), null);
    assert.deepEqual(await source(snapshot()).readLiveWorkSnapshot(), snapshot());
  });

  it("strips unknown credentials and payloads at every projected level", async () => {
    const row = snapshot();
    const projected = await source({
      ...row,
      serviceToken: "SECRET",
      subject: { ...row.subject, leaseToken: "SECRET" },
      events: [{ ...row.events[0], payload: { token: "SECRET" } }],
      omegaReadiness: { ...row.omegaReadiness, authorization: "SECRET" },
    }).readLiveWorkSnapshot();
    assert.deepEqual(projected, row);
    assert.ok(!JSON.stringify(projected).includes("SECRET"));
  });

  it("returns only the fixed ambiguity reason and hides arbitrary remote failures", async () => {
    for (const [error, expected] of [
      [
        new ConvexError({ code: "DEVELOPMENT_LIVE_WORK_AMBIGUOUS", detail: "SECRET" }),
        "Multiple Development subjects are active; live work is ambiguous.",
      ],
      [new Error("SECRET"), "Live-work state is temporarily unavailable."],
    ] as const) {
      const client: ConvexClientLike = {
        query: async () => {
          throw error;
        },
        mutation: async () => {
          throw new Error("Unexpected mutation");
        },
      };
      assert.deepEqual(
        await readLiveWorkPipeline({
          source: new ConvexDevelopmentLiveWorkSource(client, "test-token"),
        }),
        { status: "unavailable", reason: expected },
      );
    }
  });

  it("fails closed on malformed state, bounds, timestamps and readiness", async () => {
    const row = snapshot();
    for (const malformed of [
      undefined,
      {},
      { ...row, subject: { ...row.subject, state: "NOT_A_STATE" } },
      { ...row, subject: { ...row.subject, subjectVersion: -1 } },
      { ...row, subject: { ...row.subject, fencingToken: 1.5 } },
      { ...row, subject: { ...row.subject, updatedAt: Infinity } },
      { ...row, subject: { ...row.subject, subjectId: "x".repeat(513) } },
      { ...row, generatedAt: "tomorrow" },
      { ...row, events: Array.from({ length: 129 }, () => row.events[0]) },
      { ...row, omegaReadiness: { allowed: true, failures: ["blocked"] } },
      { ...row, omegaReadiness: { allowed: false, failures: [] } },
    ]) {
      await assert.rejects(source(malformed).readLiveWorkSnapshot());
      const result = await readLiveWorkPipeline({ source: source(malformed) });
      assert.equal(result.status, "unavailable");
      assert.ok(!JSON.stringify(result).includes("ZodError"));
    }
  });
});

it("accepts bounded multiline Omega objectives supported by the authoritative store", async () => {
  const row = {
    ...snapshot(),
    omegaMission: {
      missionId: "mission",
      objective: "Build safely\nVerify independently",
      state: "active",
      acceptanceCriteria: [],
    },
  };
  assert.deepEqual(await source(row).readLiveWorkSnapshot(), row);
});

it("rejects unsafe control characters in multiline Omega objectives", async () => {
  for (const objective of ["Build safely\n\u001b[31mspoofed", "Build safely\u0000hidden"]) {
    const row = {
      ...snapshot(),
      omegaMission: {
        missionId: "mission",
        objective,
        state: "active",
        acceptanceCriteria: [],
      },
    };
    await assert.rejects(source(row).readLiveWorkSnapshot(), /Invalid live-work snapshot/);
  }
});
