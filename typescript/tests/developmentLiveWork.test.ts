import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  foldLiveWorkPipeline,
  isLiveWorkMissionInFlight,
  readLiveWorkPipeline,
  type LiveWorkNode,
  type LiveWorkNodeKey,
  type LiveWorkSnapshot,
} from "../src/development/liveWork.js";
import type { DevelopmentState } from "../src/development/transitionRegistry.js";

function snapshot(overrides: Partial<LiveWorkSnapshot> = {}): LiveWorkSnapshot {
  return {
    subject: {
      subjectId: "mission-1",
      state: "BUILDING",
      repository: "Benny3840RG/Jarvis",
      branch: "agent/mission-1",
      updatedAt: Date.parse("2026-09-01T00:00:00.000Z"),
    },
    events: [],
    omegaMission: {
      missionId: "mission-1",
      objective: "Ship the live-work HUD",
      state: "active",
      acceptanceCriteria: [{ status: "satisfied" }, { status: "unverified" }],
    },
    workerStep: null,
    generatedAt: "2026-09-01T01:00:00.000Z",
    ...overrides,
  };
}

function node(nodes: readonly LiveWorkNode[], key: LiveWorkNodeKey): LiveWorkNode {
  const found = nodes.find((n) => n.key === key);
  assert.ok(found, `missing node ${key}`);
  return found;
}

describe("foldLiveWorkPipeline", () => {
  it("emits the nine canonical nodes in pipeline order", () => {
    const pipeline = foldLiveWorkPipeline(snapshot());
    assert.deepEqual(
      pipeline.nodes.map((n) => n.key),
      ["mission", "stage", "issue", "pr", "worker", "review", "ci", "merge", "omega"],
    );
  });

  it("marks nodes behind the current state done and nodes ahead pending", () => {
    const pipeline = foldLiveWorkPipeline(
      snapshot({ subject: { ...snapshot().subject, state: "REVIEW" } }),
    );
    assert.equal(node(pipeline.nodes, "issue").status, "done");
    assert.equal(node(pipeline.nodes, "ci").status, "done");
    assert.equal(node(pipeline.nodes, "review").status, "active");
    assert.equal(node(pipeline.nodes, "merge").status, "pending");
    assert.equal(node(pipeline.nodes, "omega").status, "pending");
  });

  it("blocks the review node when a review sent the mission back for repair", () => {
    const pipeline = foldLiveWorkPipeline(
      snapshot({
        subject: { ...snapshot().subject, state: "REPAIR_REQUIRED" },
        events: [
          {
            eventId: "e1",
            eventType: "DEV_TRANSITION_COMMITTED",
            transitionId: "DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED",
            occurredAt: "2026-09-01T00:30:00.000Z",
            from: "REVIEW",
            to: "REPAIR_REQUIRED",
            reasonCodes: [],
            hasMergeReceipt: false,
          },
        ],
      }),
    );
    assert.equal(node(pipeline.nodes, "review").status, "blocked");
    assert.equal(node(pipeline.nodes, "stage").status, "blocked");
    assert.equal(node(pipeline.nodes, "ci").status, "done");
  });

  it("blocks the merge node on an indeterminate merge outcome", () => {
    const pipeline = foldLiveWorkPipeline(
      snapshot({ subject: { ...snapshot().subject, state: "INDETERMINATE" } }),
    );
    assert.equal(node(pipeline.nodes, "merge").status, "blocked");
    assert.match(node(pipeline.nodes, "merge").detail, /indeterminate/i);
  });

  it("completes the Omega node only when the mission is COMPLETE", () => {
    const merged = foldLiveWorkPipeline(
      snapshot({ subject: { ...snapshot().subject, state: "MERGED" } }),
    );
    assert.equal(node(merged.nodes, "omega").status, "active");
    const complete = foldLiveWorkPipeline(
      snapshot({ subject: { ...snapshot().subject, state: "COMPLETE" } }),
    );
    assert.equal(node(complete.nodes, "omega").status, "done");
    assert.equal(node(complete.nodes, "merge").status, "done");
  });

  it("reports issue and PR detail honestly when the repository and branch are not recorded", () => {
    const pipeline = foldLiveWorkPipeline(
      snapshot({
        subject: { subjectId: "mission-1", state: "SPECIFIED", updatedAt: 0 },
      }),
    );
    assert.match(node(pipeline.nodes, "issue").detail, /not recorded/i);
    assert.match(node(pipeline.nodes, "pr").detail, /not recorded/i);
  });

  it("blocks the worker node when the lease has expired mid-build", () => {
    const pipeline = foldLiveWorkPipeline(
      snapshot({
        subject: { ...snapshot().subject, state: "BUILDING" },
        workerStep: {
          nodeId: "development",
          operationId: "github-development-worker",
          state: "running",
          leaseOwner: "worker-7",
          leaseExpiresAt: Date.parse("2026-08-01T00:00:00.000Z"),
        },
      }),
    );
    assert.equal(node(pipeline.nodes, "worker").status, "blocked");
    assert.match(node(pipeline.nodes, "worker").detail, /lease expired/i);
  });

  it("summarises committed and rejected events from safe fields only", () => {
    const pipeline = foldLiveWorkPipeline(
      snapshot({
        events: [
          {
            eventId: "e1",
            eventType: "DEV_TRANSITION_COMMITTED",
            occurredAt: "2026-09-01T00:10:00.000Z",
            from: "CLAIMED",
            to: "BUILDING",
            reasonCodes: [],
            hasMergeReceipt: false,
          },
          {
            eventId: "e2",
            eventType: "DEV_TRANSITION_REJECTED",
            occurredAt: "2026-09-01T00:20:00.000Z",
            reasonCodes: ["LEASE_EXPIRED"],
            hasMergeReceipt: false,
          },
        ],
      }),
    );
    assert.deepEqual(
      pipeline.events.map((e) => e.summary),
      ["Rejected: LEASE_EXPIRED", "Committed: CLAIMED → BUILDING"],
    );
  });

  it("flags terminal missions as not in flight", () => {
    const pipeline = foldLiveWorkPipeline(
      snapshot({ subject: { ...snapshot().subject, state: "ABORTED" } }),
    );
    assert.equal(pipeline.missionInFlight, false);
    assert.equal(node(pipeline.nodes, "mission").status, "blocked");
  });
});

describe("isLiveWorkMissionInFlight", () => {
  it("treats COMPLETE / ABORTED / FAILED / CONTRADICTED as terminal", () => {
    for (const state of ["COMPLETE", "ABORTED", "FAILED", "CONTRADICTED"] as DevelopmentState[]) {
      assert.equal(isLiveWorkMissionInFlight(state), false);
    }
    assert.equal(isLiveWorkMissionInFlight("MERGED"), true);
    assert.equal(isLiveWorkMissionInFlight("REVIEW"), true);
  });
});

describe("readLiveWorkPipeline", () => {
  it("reports available idle when no mission is in flight", async () => {
    const result = await readLiveWorkPipeline({
      source: { readLiveWorkSnapshot: async () => null },
    });
    assert.deepEqual(result, { status: "available", pipeline: null });
  });

  it("reports a truthful unavailable when the source throws, never an empty pipeline", async () => {
    const result = await readLiveWorkPipeline({
      source: {
        readLiveWorkSnapshot: async () => {
          throw new Error("convex down");
        },
      },
    });
    assert.equal(result.status, "unavailable");
    assert.match(result.status === "unavailable" ? result.reason : "", /temporarily unavailable/i);
  });

  it("folds a real snapshot into an available pipeline", async () => {
    const result = await readLiveWorkPipeline({
      source: { readLiveWorkSnapshot: async () => snapshot() },
    });
    assert.equal(result.status, "available");
    assert.equal(
      result.status === "available" ? result.pipeline?.objective : null,
      "Ship the live-work HUD",
    );
  });
});

it("uses the Development rail and never promotes Omega readiness to COMPLETE", () => {
  const input = snapshot({
    subject: { ...snapshot().subject, state: "MERGED" },
    omegaReadiness: { allowed: true, failures: [] },
  });
  const result = foldLiveWorkPipeline(input);
  assert.equal(result.state, "MERGED");
  assert.equal(result.completionLabel, "MERGED — ΩΣ READY");
  assert.deepEqual(
    result.rail.map((stage) => stage.state),
    [
      "IDEA",
      "SPECIFIED",
      "READY",
      "CLAIMED",
      "BUILDING",
      "VERIFYING",
      "REVIEW",
      "READY_TO_MERGE",
      "MERGED",
      "COMPLETE",
    ],
  );
  assert.equal(result.rail.find((stage) => stage.state === "MERGED")?.status, "active");
  assert.notEqual(node(result.nodes, "omega").status, "done");
});

it("does not use the linked Omega mission to claim Development completion", () => {
  const result = foldLiveWorkPipeline(
    snapshot({ omegaMission: { ...snapshot().omegaMission!, state: "complete" } }),
  );
  assert.notEqual(node(result.nodes, "omega").status, "done");
});

it("does not let rejected transitions mark later stages done", () => {
  const result = foldLiveWorkPipeline(
    snapshot({
      events: [
        {
          eventId: "rejected",
          eventType: "DEV_TRANSITION_REJECTED",
          occurredAt: "2026-09-01T00:00:00.000Z",
          to: "COMPLETE",
          reasonCodes: [],
          hasMergeReceipt: false,
        },
      ],
    }),
  );
  assert.equal(node(result.nodes, "review").status, "pending");
});

it("shows rebuilt candidate verification pending after repair", () => {
  const result = foldLiveWorkPipeline(
    snapshot({
      events: [
        {
          eventId: "old",
          eventType: "DEV_TRANSITION_COMMITTED",
          occurredAt: "2026-09-01T00:00:00.000Z",
          from: "REVIEW",
          to: "REPAIR_REQUIRED",
          reasonCodes: [],
          hasMergeReceipt: false,
        },
        {
          eventId: "new",
          eventType: "DEV_TRANSITION_COMMITTED",
          occurredAt: "2026-09-01T00:01:00.000Z",
          from: "REPAIR_REQUIRED",
          to: "BUILDING",
          reasonCodes: [],
          hasMergeReceipt: false,
        },
      ],
    }),
  );
  assert.equal(node(result.nodes, "worker").status, "active");
  assert.equal(node(result.nodes, "ci").status, "pending");
});
