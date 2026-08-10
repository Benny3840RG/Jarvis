import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-terminal-evidence-service-token-000";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedCompletedMission(t: ReturnType<typeof harness>) {
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-complete",
    projectKey: "omega-terminal-project",
    objective: "Freeze completion truth once the mission is complete.",
    riskClass: "R2",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.1,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "The criterion remains proven after completion.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-complete",
    nextState: "active",
  });
  await t.mutation(anyApi.omegaMissions.recordEvidence, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-complete",
    evidenceId: "EV-1",
    claim: "The completion criterion was observed.",
    classification: "high-confidence",
    sourceType: "primary-source",
    sourceRef: "omega-terminal-evidence-test",
    contradicts: [],
  });
  await t.mutation(anyApi.omegaMissions.recordValidationProof, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-complete",
    proofId: "proof-pass",
    criterionId: "AC-1",
    method: "integration",
    result: "pass",
    independent: false,
    evidenceRefs: ["EV-1"],
    performedBy: "runtime-validator",
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-complete",
    nextState: "validating",
  });
  const complete = await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-complete",
    nextState: "complete",
    residualUncertainty: 0,
  });
  expect(complete.state).toBe("complete");
}

describe("Omega completed-mission evidence immutability", () => {
  it("rejects a failed proof added after completion", async () => {
    const t = harness();
    await seedCompletedMission(t);

    await expect(
      t.mutation(anyApi.omegaMissions.recordValidationProof, {
        serviceToken: SERVICE_TOKEN,
        missionId: "mission-complete",
        proofId: "proof-after-complete",
        criterionId: "AC-1",
        method: "integration",
        result: "fail",
        independent: false,
        evidenceRefs: [],
        performedBy: "runtime-validator",
      }),
    ).rejects.toThrow(/completed mission.*immutable|terminal mission.*immutable/i);

    const mission = await t.query(anyApi.omegaMissions.get, {
      serviceToken: SERVICE_TOKEN,
      missionId: "mission-complete",
    });
    expect(mission?.state).toBe("complete");
    expect(mission?.acceptanceCriteria[0]?.status).toBe("satisfied");
  });

  it("rejects new contradictory evidence added after completion", async () => {
    const t = harness();
    await seedCompletedMission(t);

    await expect(
      t.mutation(anyApi.omegaMissions.recordEvidence, {
        serviceToken: SERVICE_TOKEN,
        missionId: "mission-complete",
        evidenceId: "EV-after-complete",
        claim: "A later observation contradicts the completed mission evidence.",
        classification: "certain",
        sourceType: "direct-measurement",
        sourceRef: "omega-terminal-evidence-test-late",
        contradicts: ["EV-1"],
      }),
    ).rejects.toThrow(/completed mission.*immutable|terminal mission.*immutable/i);

    const lateEvidence = await t.run((ctx) =>
      ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q
            .eq("ownerId", "jarvis-cli")
            .eq("missionId", "mission-complete")
            .eq("evidenceId", "EV-after-complete"),
        )
        .unique(),
    );
    expect(lateEvidence).toBeNull();
  });
});
