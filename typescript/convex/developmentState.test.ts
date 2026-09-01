import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "development-state-test-service-token-00000";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const missionAuthority = {
  repositories: ["Benny3840RG/Jarvis"],
  branches: ["agent/governed-dev-state-machine-phase1"],
  externalEffects: ["github.merge"],
  maxRiskClass: 3,
};

function claimedToBuildingArgs(overrides: Record<string, unknown> = {}) {
  return {
    serviceToken: SERVICE_TOKEN,
    subjectId: "mission-1",
    eventId: "event-1",
    correlationId: "correlation-1",
    transitionId: "DEV_TRANSITION_CLAIMED_TO_BUILDING" as const,
    to: "BUILDING" as const,
    now: "2026-09-01T00:00:00.000Z",
    requestedBy: { actorType: "worker" as const, actorId: "worker-1" },
    committedBy: { actorType: "controller" as const, actorId: "development-controller" },
    workerId: "worker-1",
    lease: {
      leaseToken: "lease-token-1",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-09-01T01:00:00.000Z",
      fencingToken: 1,
    },
    missionAuthority,
    workerAuthority: missionAuthority,
    ...overrides,
  };
}

describe("developmentState.create", () => {
  it("creates a subject at the given initial state", async () => {
    const t = harness();
    const subject = await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      initialState: "CLAIMED",
    });

    expect(subject.state).toBe("CLAIMED");
    expect(subject.subjectVersion).toBe(0);
    expect(subject.projectionVersion).toBe(0);
  });

  it("is idempotent when called again with the same initial state", async () => {
    const t = harness();
    const first = await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      initialState: "CLAIMED",
    });
    const second = await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      initialState: "CLAIMED",
    });

    expect(second._id).toBe(first._id);
  });

  it("rejects a second create for the same subject with a different initial state", async () => {
    const t = harness();
    await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      initialState: "CLAIMED",
    });

    await expect(
      t.mutation(api.developmentState.create, {
        serviceToken: SERVICE_TOKEN,
        subjectId: "mission-1",
        initialState: "READY",
      }),
    ).rejects.toThrow(/different initial state/);
  });
});

describe("developmentState.commit", () => {
  it("commits a legal transition, advancing state, version, and recording the fencing token", async () => {
    const t = harness();
    await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      initialState: "CLAIMED",
    });

    const outcome = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());

    expect(outcome.kind).toBe("COMMITTED");
    expect(outcome.subject.state).toBe("BUILDING");
    expect(outcome.subject.subjectVersion).toBe(1);
    expect(outcome.subject.fencingToken).toBe(1);
    expect(outcome.event.eventType).toBe("DEV_TRANSITION_COMMITTED");
  });

  it("rejects an illegal transition and leaves the subject untouched, recording an audit event", async () => {
    const t = harness();
    await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      initialState: "READY",
    });

    const outcome = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("STATE_MISMATCH");
    expect(outcome.subject.state).toBe("READY");
    expect(outcome.subject.subjectVersion).toBe(0);
    expect(outcome.event.eventType).toBe("DEV_TRANSITION_REJECTED");

    const events = await t.query(api.developmentState.listEvents, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("DEV_TRANSITION_REJECTED");
  });

  it("is idempotent: replaying the same event ID returns the original outcome without a second state change", async () => {
    const t = harness();
    await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      initialState: "CLAIMED",
    });

    const first = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());
    const second = await t.mutation(api.developmentState.commit, claimedToBuildingArgs());

    expect(second.kind).toBe("COMMITTED");
    expect(second.subject.subjectVersion).toBe(1);
    expect(second.event._id).toBe(first.event._id);

    const events = await t.query(api.developmentState.listEvents, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
    });
    expect(events).toHaveLength(1);
  });

  it("serializes two workers racing the same claim to exactly one winner (real Convex OCC)", async () => {
    const t = harness();
    await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      initialState: "CLAIMED",
    });

    const results = await Promise.allSettled([
      t.mutation(
        api.developmentState.commit,
        claimedToBuildingArgs({ eventId: "event-worker-a", expectedSubjectVersion: 0 }),
      ),
      t.mutation(
        api.developmentState.commit,
        claimedToBuildingArgs({ eventId: "event-worker-b", expectedSubjectVersion: 0 }),
      ),
    ]);

    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<
      Awaited<ReturnType<typeof t.mutation<typeof api.developmentState.commit>>>
    >[];
    const committed = fulfilled.filter((result) => result.value.kind === "COMMITTED");
    const rejected = fulfilled.filter((result) => result.value.kind === "REJECTED");

    expect(committed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.value.reasons).toContain("STALE_SUBJECT_VERSION");

    const subject = await t.query(api.developmentState.get, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
    });
    expect(subject?.subjectVersion).toBe(1);
  });

  it("rejects a stale fencing token through the real mutation, distinctly from expiry", async () => {
    const t = harness();
    await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      initialState: "CLAIMED",
    });
    await t.run(async (ctx) => {
      const subject = await ctx.db
        .query("developmentSubjects")
        .withIndex("by_owner_and_subject_id", (q) =>
          q.eq("ownerId", "jarvis-cli").eq("subjectId", "mission-1"),
        )
        .unique();
      if (subject) await ctx.db.patch("developmentSubjects", subject._id, { fencingToken: 5 });
    });

    const outcome = await t.mutation(
      api.developmentState.commit,
      claimedToBuildingArgs({
        workerId: "worker-b",
        lease: {
          leaseToken: "lease-token-3",
          leaseOwner: "worker-b",
          leaseExpiresAt: "2026-09-01T01:00:00.000Z",
          fencingToken: 3,
        },
      }),
    );

    expect(outcome.kind).toBe("REJECTED");
    expect(outcome.reasons).toContain("STALE_FENCING_TOKEN");
  });

  it("refuses to commit MERGED_TO_COMPLETE -- real Omega completion must go through omegaMissions.transition", async () => {
    const t = harness();
    await t.mutation(api.developmentState.create, {
      serviceToken: SERVICE_TOKEN,
      subjectId: "mission-1",
      initialState: "MERGED",
    });

    await expect(
      t.mutation(api.developmentState.commit, {
        serviceToken: SERVICE_TOKEN,
        subjectId: "mission-1",
        eventId: "event-1",
        correlationId: "correlation-1",
        transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
        to: "COMPLETE",
        now: "2026-09-01T00:00:00.000Z",
        requestedBy: { actorType: "controller", actorId: "mission-engine" },
        committedBy: { actorType: "omega", actorId: "omega-sigma" },
      }),
    ).rejects.toThrow(/omegaMissions\.transition/);
  });
});
