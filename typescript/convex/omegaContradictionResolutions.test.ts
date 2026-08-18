import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-resolution-service-token-000000000";
const APPROVAL_TOKEN = "omega-resolution-approval-token-000000000";

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

async function createMission(t: ReturnType<typeof harness>, missionId: string) {
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId,
    projectKey: `project-${missionId}`,
    objective: "Resolve an exact evidence contradiction without rewriting history.",
    riskClass: "R2",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.1,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "Completion truth remains auditable.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
}

async function recordEvidence(
  t: ReturnType<typeof harness>,
  missionId: string,
  evidenceId: string,
  contradicts: string[] = [],
) {
  return t.mutation(anyApi.omegaMissions.recordEvidence, {
    serviceToken: SERVICE_TOKEN,
    missionId,
    evidenceId,
    claim: `Evidence ${evidenceId}`,
    classification: evidenceId.includes("CONTRA") ? "certain" : "high-confidence",
    sourceType: "primary-source",
    sourceRef: "omega-contradiction-resolution-test",
    contradicts,
  });
}

async function seedContradiction(t: ReturnType<typeof harness>, missionId = "mission-resolution") {
  await createMission(t, missionId);
  await recordEvidence(t, missionId, "EV-BASE");
  await recordEvidence(t, missionId, "EV-CONTRA", ["EV-BASE"]);
  await recordEvidence(t, missionId, "EV-NONCONTRA");
}

function resolutionArgs(overrides: Record<string, unknown> = {}) {
  return {
    serviceToken: SERVICE_TOKEN,
    approvalToken: APPROVAL_TOKEN,
    missionId: "mission-resolution",
    resolutionId: "RES-1",
    contradictionEvidenceId: "EV-CONTRA",
    contradictedEvidenceId: "EV-BASE",
    reason: "Independent review established the base observation was stale.",
    resolvedBy: "owner-review",
    ...overrides,
  };
}

describe("Omega contradiction resolution integrity", () => {
  it("requires the dedicated approval credential", async () => {
    const t = harness();
    await seedContradiction(t);

    const { approvalToken: _approvalToken, ...withoutApproval } = resolutionArgs();
    await expect(
      t.mutation(anyApi.omegaContradictionResolutions.record, withoutApproval),
    ).rejects.toThrow(/approval token/i);
  });

  it("records one immutable exact-edge resolution and replays the same ID idempotently", async () => {
    const t = harness();
    await seedContradiction(t);

    const first = await t.mutation(anyApi.omegaContradictionResolutions.record, resolutionArgs());
    const replay = await t.mutation(anyApi.omegaContradictionResolutions.record, resolutionArgs());

    expect(first.resolutionId).toBe("RES-1");
    expect(first.contradictionEvidenceId).toBe("EV-CONTRA");
    expect(first.contradictedEvidenceId).toBe("EV-BASE");
    expect(first.authority).toBe("approval-token");
    expect(first.resolvedBy).toBe("owner-review");
    expect(first.resolvedAt).toBeGreaterThan(0);
    expect(replay._id).toBe(first._id);
    expect(replay.resolvedAt).toBe(first.resolvedAt);
  });

  it("rejects a reused resolution ID with different governed contents", async () => {
    const t = harness();
    await seedContradiction(t);
    await t.mutation(anyApi.omegaContradictionResolutions.record, resolutionArgs());

    await expect(
      t.mutation(
        anyApi.omegaContradictionResolutions.record,
        resolutionArgs({ reason: "A different explanation must not overwrite history." }),
      ),
    ).rejects.toThrow(/resolution id.*different contents/i);
  });

  it("rejects missing or cross-mission evidence and a source that does not name the target", async () => {
    const t = harness();
    await seedContradiction(t);
    await createMission(t, "mission-other");
    await recordEvidence(t, "mission-other", "EV-OTHER");

    await expect(
      t.mutation(
        anyApi.omegaContradictionResolutions.record,
        resolutionArgs({ contradictionEvidenceId: "EV-MISSING" }),
      ),
    ).rejects.toThrow(/contradicting evidence.*does not exist/i);

    await expect(
      t.mutation(
        anyApi.omegaContradictionResolutions.record,
        resolutionArgs({ contradictedEvidenceId: "EV-OTHER" }),
      ),
    ).rejects.toThrow(/contradicted evidence.*does not exist/i);

    await expect(
      t.mutation(
        anyApi.omegaContradictionResolutions.record,
        resolutionArgs({ contradictionEvidenceId: "EV-NONCONTRA" }),
      ),
    ).rejects.toThrow(/does not contradict/i);
  });

  it("rejects a second resolution ID for an already-resolved edge", async () => {
    const t = harness();
    await seedContradiction(t);
    await t.mutation(anyApi.omegaContradictionResolutions.record, resolutionArgs());

    await expect(
      t.mutation(
        anyApi.omegaContradictionResolutions.record,
        resolutionArgs({ resolutionId: "RES-2" }),
      ),
    ).rejects.toThrow(/contradiction edge.*already resolved/i);
  });

  it("rejects resolution after the mission becomes terminal", async () => {
    const t = harness();
    await seedContradiction(t);
    await t.mutation(anyApi.omegaMissions.transition, {
      serviceToken: SERVICE_TOKEN,
      missionId: "mission-resolution",
      nextState: "aborted",
    });
    await t.mutation(anyApi.omegaMissions.transition, {
      serviceToken: SERVICE_TOKEN,
      missionId: "mission-resolution",
      nextState: "retired",
    });

    await expect(
      t.mutation(anyApi.omegaContradictionResolutions.record, resolutionArgs()),
    ).rejects.toThrow(/terminal mission.*immutable/i);
  });

  it("allows at most one durable winner when two resolution IDs race for one edge", async () => {
    const t = harness();
    await seedContradiction(t);

    const firstArgs = resolutionArgs({ resolutionId: "RES-RACE-1" });
    const secondArgs = resolutionArgs({ resolutionId: "RES-RACE-2" });
    const results = await Promise.allSettled([
      t.mutation(anyApi.omegaContradictionResolutions.record, firstArgs),
      t.mutation(anyApi.omegaContradictionResolutions.record, secondArgs),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = fulfilled[0];
    expect(winner.status).toBe("fulfilled");
    if (winner.status !== "fulfilled") throw new Error("Expected one durable resolution winner.");
    const winningArgs = winner.value.resolutionId === "RES-RACE-1" ? firstArgs : secondArgs;
    const losingArgs = winner.value.resolutionId === "RES-RACE-1" ? secondArgs : firstArgs;

    const replay = await t.mutation(anyApi.omegaContradictionResolutions.record, winningArgs);
    expect(replay._id).toBe(winner.value._id);
    await expect(
      t.mutation(anyApi.omegaContradictionResolutions.record, losingArgs),
    ).rejects.toThrow(/contradiction edge.*already resolved/i);
  });
});
