import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-waiver-service-token-0000000000";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedWaivedMission(t: ReturnType<typeof harness>) {
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-waiver",
    projectKey: "omega-waiver-project",
    objective: "Require every completion criterion to be proven, not waived.",
    riskClass: "R3",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.1,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "The criterion must be proven before mission completion.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-waiver",
    nextState: "active",
  });
  await t.mutation(anyApi.omegaMissions.recordValidationProof, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-waiver",
    proofId: "proof-waiver",
    criterionId: "AC-1",
    method: "independent",
    result: "waived",
    independent: false,
    evidenceRefs: [],
    performedBy: "runtime-validator",
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-waiver",
    nextState: "validating",
  });
}

describe("Omega acceptance-criterion waiver safety", () => {
  it("does not let a waived criterion satisfy mission completion", async () => {
    const t = harness();
    await seedWaivedMission(t);

    await expect(
      t.mutation(anyApi.omegaMissions.transition, {
        serviceToken: SERVICE_TOKEN,
        missionId: "mission-waiver",
        nextState: "complete",
        residualUncertainty: 0,
      }),
    ).rejects.toThrow(/acceptance-criteria-incomplete/i);
  });
});
