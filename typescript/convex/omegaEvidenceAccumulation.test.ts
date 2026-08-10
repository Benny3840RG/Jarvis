import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-evidence-accumulation-service-token";
const OWNER_ID = "jarvis-cli";
const PROJECT_KEY = "omega-evidence-project";
const MISSION_ID = "omega-evidence-mission";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedProject(ctx: MutationCtx) {
  return ctx.db.insert("projects", {
    ownerId: OWNER_ID,
    projectKey: PROJECT_KEY,
    projectName: "Omega evidence accumulation",
    projectType: "test",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
    domains: ["business"],
    summary: "Omega evidence accumulation test project.",
    preferences: {
      outputStyle: "concise",
      communicationTone: "neutral",
      detailLevel: "standard",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
}

describe("Omega criterion evidence accumulation", () => {
  it("preserves earlier criterion evidence when later passing proofs are recorded", async () => {
    const t = harness();
    await t.run((ctx) => seedProject(ctx));
    await t.mutation(api.omegaMissions.create, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
      projectKey: PROJECT_KEY,
      objective: "Keep all evidence that supports the acceptance criterion.",
      riskClass: "R3",
      autonomyClass: "A3",
      reversibilityClass: "REV-3",
      uncertaintyBudget: 0.2,
      acceptanceCriteria: [
        {
          criterionId: "AC-1",
          statement: "The criterion retains independent and corroborating evidence.",
          status: "unverified",
          evidenceRefs: [],
        },
      ],
    });
    await t.mutation(api.omegaMissions.transition, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
      nextState: "active",
    });

    for (const evidenceId of ["EV-independent", "EV-corroborating"]) {
      await t.mutation(api.omegaMissions.recordEvidence, {
        serviceToken: SERVICE_TOKEN,
        missionId: MISSION_ID,
        evidenceId,
        claim: `Evidence ${evidenceId} supports AC-1.`,
        classification: "certain",
        sourceType:
          evidenceId === "EV-independent" ? "independent-verification" : "direct-measurement",
        sourceRef: "omega-evidence-test",
        contradicts: [],
      });
    }

    await t.mutation(api.omegaMissions.recordValidationProof, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
      proofId: "proof-independent",
      criterionId: "AC-1",
      method: "independent",
      result: "pass",
      independent: true,
      evidenceRefs: ["EV-independent"],
      performedBy: "independent-reviewer",
    });
    await t.mutation(api.omegaMissions.recordValidationProof, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
      proofId: "proof-corroborating",
      criterionId: "AC-1",
      method: "integration",
      result: "pass",
      independent: false,
      evidenceRefs: ["EV-corroborating"],
      performedBy: "runtime-test",
    });

    const mission = await t.query(api.omegaMissions.get, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
    });
    expect(mission?.acceptanceCriteria[0]?.evidenceRefs).toEqual([
      "EV-independent",
      "EV-corroborating",
    ]);
  });
});
