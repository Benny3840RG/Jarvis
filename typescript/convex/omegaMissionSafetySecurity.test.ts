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
  it("removes blocked-to-active from the generic service-token transition surface", async () => {
    const t = harness();
    await seedBlockedMission(t);

    await expect(
      t.mutation(anyApi.omegaMissions.transition, {
        serviceToken: SERVICE_TOKEN,
        missionId: "mission-blocked",
        nextState: "active",
      }),
    ).rejects.toThrow(/invalid omega mission transition/i);
  });

  it("rejects dedicated unblock without a valid human approval credential", async () => {
    const t = harness();
    await seedBlockedMission(t);

    await expect(
      t.mutation(anyApi.omegaMissionControls.unblock, {
        serviceToken: SERVICE_TOKEN,
        approvalToken: "",
        missionId: "mission-blocked",
        reason: "Operator reviewed the blocking condition.",
      }),
    ).rejects.toThrow(/approval token/i);
  });

  it("allows dedicated unblock with the human approval credential and audits the decision", async () => {
    const t = harness();
    await seedBlockedMission(t);

    const mission = await t.mutation(anyApi.omegaMissionControls.unblock, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      missionId: "mission-blocked",
      reason: "Operator reviewed the blocking condition.",
    });

    expect(mission.state).toBe("active");
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_owner_and_request_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("requestId", "omega-unblock:mission-blocked"),
        )
        .unique(),
    );
    expect(audit?.eventType).toBe("omega.mission.unblocked");
    expect(audit?.actor).toBe("user");
    expect(audit?.payload.reason).toBe("Operator reviewed the blocking condition.");
  });
});
