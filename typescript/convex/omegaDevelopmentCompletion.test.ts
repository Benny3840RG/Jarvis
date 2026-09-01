import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-development-completion-service-token";
const OWNER_ID = "jarvis-cli";
const MISSION_ID = "development-mission-1";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedCompletableMission(t: ReturnType<typeof harness>) {
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("developmentSubjects", {
      ownerId: OWNER_ID,
      subjectId: MISSION_ID,
      state: "MERGED",
      subjectVersion: 9,
      projectionVersion: 9,
      reducerVersion: "DevelopmentReducer/v1",
      lastEventId: "merge-event",
      orchestrationRunId: "run-1",
      orchestrationNodeId: "development",
      omegaMissionId: MISSION_ID,
      repository: "Benny3840RG/Jarvis",
      branch: "main",
      createdAt: now,
      updatedAt: now,
    });
  });
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    projectKey: MISSION_ID,
    objective: "Prove the merged development mission remains correct after merge.",
    riskClass: "R0",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.1,
    acceptanceCriteria: [
      {
        criterionId: "post-merge-ci",
        statement: "The merged commit exists and required post-merge CI passes.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    nextState: "active",
  });
  await t.mutation(anyApi.omegaMissions.recordEvidence, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    evidenceId: "github-post-merge-ci:abc123",
    claim: "GitHub reports the merged commit exists and required CI succeeded.",
    classification: "certain",
    sourceType: "primary-source",
    sourceRef: "github-rest-v1:Benny3840RG/Jarvis:abc123",
    contradicts: [],
  });
  await t.mutation(anyApi.omegaMissions.recordValidationProof, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    proofId: "post-merge-proof:abc123",
    criterionId: "post-merge-ci",
    method: "operational",
    result: "pass",
    independent: false,
    evidenceRefs: ["github-post-merge-ci:abc123"],
    performedBy: "github-post-merge-observer",
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    nextState: "validating",
  });
}

describe("Omega development completion projection", () => {
  it("lets the existing Omega boundary atomically commit the development COMPLETE projection", async () => {
    const t = harness();
    await seedCompletableMission(t);

    const completed = await t.mutation(anyApi.omegaMissions.transition, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
      nextState: "complete",
      residualUncertainty: 0,
    });

    expect(completed.state).toBe("complete");
    const development = await t.query(anyApi.developmentState.get, {
      serviceToken: SERVICE_TOKEN,
      subjectId: MISSION_ID,
    });
    expect(development?.state).toBe("COMPLETE");
    expect(development?.subjectVersion).toBe(10);

    const events = await t.query(anyApi.developmentState.listEvents, {
      serviceToken: SERVICE_TOKEN,
      subjectId: MISSION_ID,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      transitionId: "DEV_TRANSITION_MERGED_TO_COMPLETE",
      committedBy: { actorType: "omega", actorId: "omega-sigma" },
      evidenceIds: ["github-post-merge-ci:abc123"],
    });
  });

  it("fails closed without partially completing Omega when the development subject is not MERGED", async () => {
    const t = harness();
    await seedCompletableMission(t);
    await t.run(async (ctx) => {
      const development = await ctx.db
        .query("developmentSubjects")
        .withIndex("by_owner_and_subject_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("subjectId", MISSION_ID),
        )
        .unique();
      if (!development) throw new Error("missing test subject");
      await ctx.db.patch("developmentSubjects", development._id, { state: "READY_TO_MERGE" });
    });

    await expect(
      t.mutation(anyApi.omegaMissions.transition, {
        serviceToken: SERVICE_TOKEN,
        missionId: MISSION_ID,
        nextState: "complete",
        residualUncertainty: 0,
      }),
    ).rejects.toThrow(/development subject must be MERGED/i);

    const omega = await t.query(anyApi.omegaMissions.get, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
    });
    expect(omega?.state).toBe("validating");
  });
});
