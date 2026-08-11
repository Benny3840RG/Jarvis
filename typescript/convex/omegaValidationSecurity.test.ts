import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-validation-service-token-00000000";
const APPROVAL_TOKEN = "omega-validation-approval-token-00000000";

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

async function seedMissionAndEvidence(t: ReturnType<typeof harness>) {
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-independent-validation",
    projectKey: "omega-validation-project",
    objective: "Prevent the execution service from self-asserting independent validation.",
    riskClass: "R3",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.1,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "Independent validation must cross a separate authority boundary.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
  await t.mutation(anyApi.omegaMissions.recordEvidence, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-independent-validation",
    evidenceId: "EV-1",
    claim: "The validation boundary was exercised.",
    classification: "high-confidence",
    sourceType: "primary-source",
    sourceRef: "omega-validation-security-test",
    contradicts: [],
  });
}

function proofArgs(independent: boolean) {
  return {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-independent-validation",
    proofId: independent ? "proof-independent" : "proof-routine",
    criterionId: "AC-1",
    method: independent ? "independent" : "integration",
    result: "pass",
    independent,
    evidenceRefs: ["EV-1"],
    performedBy: independent ? "independent-reviewer" : "runtime-validator",
  };
}

describe("Omega independent validation security", () => {
  it("rejects a shared-service caller that self-asserts an independent proof", async () => {
    const t = harness();
    await seedMissionAndEvidence(t);

    await expect(
      t.mutation(anyApi.omegaMissions.recordValidationProof, proofArgs(true)),
    ).rejects.toThrow(/approval token/i);
  });

  it("accepts an independent proof only with the dedicated approval credential", async () => {
    const t = harness();
    await seedMissionAndEvidence(t);

    const proof = await t.mutation(anyApi.omegaMissions.recordValidationProof, {
      ...proofArgs(true),
      approvalToken: APPROVAL_TOKEN,
    });

    expect(proof.independent).toBe(true);
    expect(proof.performedBy).toBe("independent-reviewer");
  });

  it("keeps routine non-independent proof recording available to the service boundary", async () => {
    const t = harness();
    await seedMissionAndEvidence(t);

    const proof = await t.mutation(anyApi.omegaMissions.recordValidationProof, proofArgs(false));

    expect(proof.independent).toBe(false);
    expect(proof.performedBy).toBe("runtime-validator");
  });
});
