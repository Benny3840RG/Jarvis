import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-mission-safety-service-token-000000";
const APPROVAL_TOKEN = "omega-mission-safety-approval-token-000000";
const OWNER_ID = "jarvis-cli";
const PROJECT_KEY = "omega-mission-safety-project";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", APPROVAL_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedProject(ctx: MutationCtx) {
  await ctx.db.insert("projects", {
    ownerId: OWNER_ID,
    projectKey: PROJECT_KEY,
    projectName: "Omega mission safety",
    projectType: "test",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 1,
    domains: ["business"],
    summary: "Blocked missions must not be reactivated by the shared service credential.",
    preferences: {
      outputStyle: "concise",
      communicationTone: "neutral",
      detailLevel: "standard",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
}

async function seedBlockedMission(t: ReturnType<typeof harness>) {
  await t.run((ctx) => seedProject(ctx));
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-blocked",
    projectKey: PROJECT_KEY,
    objective: "Require human authority to clear a hard mission block.",
    riskClass: "R3",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.2,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "A hard block cannot be cleared by service access alone.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-blocked",
    nextState: "active",
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-blocked",
    nextState: "blocked",
  });
}

describe("Omega mission hard-block security", () => {
  it("rejects service-token-only reactivation of a blocked mission", async () => {
    const t = harness();
    await seedBlockedMission(t);

    await expect(
      t.mutation(anyApi.omegaMissions.transition, {
        serviceToken: SERVICE_TOKEN,
        missionId: "mission-blocked",
        nextState: "active",
      }),
    ).rejects.toThrow(/approval token/i);
  });

  it("allows a blocked mission to reactivate with the dedicated human approval credential", async () => {
    const t = harness();
    await seedBlockedMission(t);

    const mission = await t.mutation(anyApi.omegaMissions.transition, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      missionId: "mission-blocked",
      nextState: "active",
    });

    expect(mission.state).toBe("active");
  });
});
