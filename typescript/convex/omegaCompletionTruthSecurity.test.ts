import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-completion-service-token-0000000000";
const APPROVAL_TOKEN = "omega-completion-approval-token-000000000";
const OWNER_ID = "jarvis-cli";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", APPROVAL_TOKEN);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function createMission(
  t: ReturnType<typeof harness>,
  missionId: string,
  riskClass: "R2" | "R3" = "R2",
) {
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId,
    projectKey: `project-${missionId}`,
    objective: "Prove completion derives from current immutable truth.",
    riskClass,
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.1,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "Authoritative completion truth is satisfied.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId,
    nextState: "active",
  });
}

async function recordEvidence(
  t: ReturnType<typeof harness>,
  missionId: string,
  evidenceId: string,
  options: {
    classification?: "certain" | "high-confidence";
    validUntil?: number;
    contradicts?: string[];
  } = {},
) {
  return t.mutation(anyApi.omegaMissions.recordEvidence, {
    serviceToken: SERVICE_TOKEN,
    missionId,
    evidenceId,
    claim: `Evidence ${evidenceId}`,
    classification: options.classification ?? "high-confidence",
    sourceType: "primary-source",
    sourceRef: "omega-completion-truth-security-test",
    ...(options.validUntil === undefined
      ? {}
      : { validUntil: options.validUntil }),
    contradicts: options.contradicts ?? [],
  });
}

async function recordPassingProof(
  t: ReturnType<typeof harness>,
  missionId: string,
  evidenceRefs: string[],
  independent = false,
) {
  return t.mutation(anyApi.omegaMissions.recordValidationProof, {
    serviceToken: SERVICE_TOKEN,
    ...(independent ? { approvalToken: APPROVAL_TOKEN } : {}),
    missionId,
    proofId: `PROOF-${missionId}`,
    criterionId: "AC-1",
    method: independent ? "independent" : "integration",
    result: "pass",
    independent,
    evidenceRefs,
    performedBy: independent ? "independent-reviewer" : "omega-test",
  });
}

async function beginValidation(
  t: ReturnType<typeof harness>,
  missionId: string,
) {
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId,
    nextState: "validating",
  });
}

async function completeMission(
  t: ReturnType<typeof harness>,
  missionId: string,
) {
  return t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId,
    nextState: "complete",
    residualUncertainty: 0,
  });
}

async function resolveEdge(
  t: ReturnType<typeof harness>,
  missionId: string,
  resolutionId: string,
  contradictionEvidenceId: string,
  contradictedEvidenceId: string,
) {
  return t.mutation(anyApi.omegaContradictionResolutions.record, {
    serviceToken: SERVICE_TOKEN,
    approvalToken: APPROVAL_TOKEN,
    missionId,
    resolutionId,
    contradictionEvidenceId,
    contradictedEvidenceId,
    reason: `Resolve ${contradictionEvidenceId} -> ${contradictedEvidenceId} after governed review.`,
    resolvedBy: "owner-review",
  });
}

describe("Omega completion truth security", () => {
  it("ignores compatibility projection without a current proof", async () => {
    const t = harness();
    const missionId = "mission-projection-only";
    await createMission(t, missionId);

    await t.run(async (ctx) => {
      const mission = await ctx.db
        .query("omegaMissions")
        .withIndex("by_owner_and_mission_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("missionId", missionId),
        )
        .unique();
      if (!mission) throw new Error("Mission missing in test setup.");
      await ctx.db.patch("omegaMissions", mission._id, {
        acceptanceCriteria: mission.acceptanceCriteria.map((criterion) => ({
          ...criterion,
          status: "satisfied" as const,
          evidenceRefs: ["EV-FAKE"],
        })),
      });
    });

    await beginValidation(t, missionId);
    await expect(completeMission(t, missionId)).rejects.toThrow(
      /criterion-missing-passing-proof/i,
    );
  });

  it("completes from proof when compatibility projection is stale", async () => {
    const t = harness();
    const missionId = "mission-stale-projection";
    await createMission(t, missionId);
    await recordEvidence(t, missionId, "EV-CURRENT");
    await recordPassingProof(t, missionId, ["EV-CURRENT"]);

    await t.run(async (ctx) => {
      const mission = await ctx.db
        .query("omegaMissions")
        .withIndex("by_owner_and_mission_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("missionId", missionId),
        )
        .unique();
      if (!mission) throw new Error("Mission missing in test setup.");
      await ctx.db.patch("omegaMissions", mission._id, {
        acceptanceCriteria: mission.acceptanceCriteria.map((criterion) => ({
          ...criterion,
          status: "unverified" as const,
          evidenceRefs: [],
        })),
      });
    });

    await beginValidation(t, missionId);
    const completed = await completeMission(t, missionId);
    expect(completed.state).toBe("complete");
  });

  it("drops a proof when any evidence ref is not current", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const t = harness();
    const missionId = "mission-whole-proof-currentness";
    await createMission(t, missionId);
    await recordEvidence(t, missionId, "EV-CURRENT");
    await recordEvidence(t, missionId, "EV-EXPIRES", {
      validUntil: 20_000,
    });
    await recordPassingProof(t, missionId, ["EV-CURRENT", "EV-EXPIRES"]);
    await beginValidation(t, missionId);

    vi.setSystemTime(30_000);
    await expect(completeMission(t, missionId)).rejects.toThrow(
      /criterion-missing-passing-proof/i,
    );
  });

  it("requires a current independent proof for R3", async () => {
    const t = harness();
    const missionId = "mission-independent-proof";
    await createMission(t, missionId, "R3");
    await recordEvidence(t, missionId, "EV-CURRENT");
    await recordPassingProof(t, missionId, ["EV-CURRENT"], false);
    await beginValidation(t, missionId);

    await expect(completeMission(t, missionId)).rejects.toThrow(
      /criterion-missing-independent-proof/i,
    );
  });

  it("resolves contradiction edges exactly", async () => {
    const t = harness();
    const missionId = "mission-exact-edge-resolution";
    await createMission(t, missionId);
    await recordEvidence(t, missionId, "EV-PROOF");
    await recordEvidence(t, missionId, "EV-BASE-1");
    await recordEvidence(t, missionId, "EV-BASE-2");
    await recordEvidence(t, missionId, "EV-CONTRA", {
      classification: "certain",
      contradicts: ["EV-BASE-1", "EV-BASE-2"],
    });
    await recordPassingProof(t, missionId, ["EV-PROOF"]);
    await resolveEdge(
      t,
      missionId,
      "RES-EDGE-1",
      "EV-CONTRA",
      "EV-BASE-1",
    );
    await beginValidation(t, missionId);

    await expect(completeMission(t, missionId)).rejects.toThrow(
      /critical-evidence-contradiction/i,
    );
  });

  it("completes only after every current edge is resolved", async () => {
    const t = harness();
    const missionId = "mission-all-edges-resolved";
    await createMission(t, missionId);
    await recordEvidence(t, missionId, "EV-PROOF");
    await recordEvidence(t, missionId, "EV-BASE-1");
    await recordEvidence(t, missionId, "EV-BASE-2");
    await recordEvidence(t, missionId, "EV-CONTRA", {
      classification: "certain",
      contradicts: ["EV-BASE-1", "EV-BASE-2"],
    });
    await recordPassingProof(t, missionId, ["EV-PROOF"]);
    await resolveEdge(
      t,
      missionId,
      "RES-EDGE-1",
      "EV-CONTRA",
      "EV-BASE-1",
    );
    await resolveEdge(
      t,
      missionId,
      "RES-EDGE-2",
      "EV-CONTRA",
      "EV-BASE-2",
    );
    await beginValidation(t, missionId);

    const completed = await completeMission(t, missionId);
    expect(completed.state).toBe("complete");
  });

  it("keeps dangling legacy contradictions blocking", async () => {
    const t = harness();
    const missionId = "mission-dangling-legacy-edge";
    await createMission(t, missionId);
    await recordEvidence(t, missionId, "EV-PROOF");
    await recordPassingProof(t, missionId, ["EV-PROOF"]);

    await t.run(async (ctx) => {
      await ctx.db.insert("omegaEvidence", {
        ownerId: OWNER_ID,
        missionId,
        evidenceId: "EV-LEGACY-CONTRA",
        claim: "Legacy certain evidence references a missing historical row.",
        classification: "certain",
        sourceType: "primary-source",
        sourceRef: "legacy-seed",
        contradicts: ["EV-MISSING"],
        createdAt: Date.now(),
      });
    });

    await beginValidation(t, missionId);
    await expect(completeMission(t, missionId)).rejects.toThrow(
      /critical-evidence-contradiction/i,
    );
  });
});
