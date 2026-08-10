import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-runtime-test-service-token-000000";
const APPROVAL_TOKEN = "omega-runtime-approval-token-000000000";
const OWNER_ID = "jarvis-cli";
const PROJECT_KEY = "omega-project";

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

async function seedProject(ctx: MutationCtx) {
  return ctx.db.insert("projects", {
    ownerId: OWNER_ID,
    projectKey: PROJECT_KEY,
    projectName: "Omega test project",
    projectType: "test",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 1,
    domains: ["business"],
    summary: "Omega runtime integration test.",
    preferences: {
      outputStyle: "concise",
      communicationTone: "neutral",
      detailLevel: "standard",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
}

async function createActiveMission(t: ReturnType<typeof harness>, missionId = "mission-1") {
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId,
    projectKey: PROJECT_KEY,
    objective: "Prove the governed Omega execution path.",
    riskClass: "R3",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.2,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "The governed action produces a durable terminal receipt.",
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

async function stageAndApproveDestructiveAction(
  t: ReturnType<typeof harness>,
  actionId = "action-1",
  now = 10_000,
) {
  await t.mutation(anyApi.toolActions.stage, {
    serviceToken: SERVICE_TOKEN,
    actionId,
    requestId: `request-${actionId}`,
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    tool: "quotes",
    operation: "send",
    arguments: { quoteId: "quote-1" },
    rationale: "Exercise a governed one-shot external effect.",
    requiredAuthority: "T3",
    destructive: true,
    idempotencyKey: `idempotency-${actionId}`,
    proposedBy: "agent",
  });
  return t.mutation(anyApi.toolActions.approve, {
    serviceToken: SERVICE_TOKEN,
    approvalToken: APPROVAL_TOKEN,
    projectKey: PROJECT_KEY,
    actionId,
    expectedRevision: 1,
    now,
    approvalTtlMs: 60_000,
  });
}

async function bindAndAuthorize(
  t: ReturnType<typeof harness>,
  missionId = "mission-1",
  actionId = "action-1",
  now = 10_100,
) {
  await t.mutation(anyApi.omegaActionContracts.create, {
    serviceToken: SERVICE_TOKEN,
    missionId,
    contractId: `contract-${actionId}`,
    toolActionId: actionId,
    intent: "Execute the approved one-shot action.",
    riskClass: "R3",
    reversibilityClass: "REV-2",
    requiredAuthority: "T3",
    scope: { projectKey: PROJECT_KEY },
    preconditions: ["underlying-action-approved"],
    rollbackPlan: "Reconcile and surface the terminal outcome; never duplicate-send.",
  });
  return t.mutation(anyApi.omegaActionContracts.authorize, {
    serviceToken: SERVICE_TOKEN,
    missionId,
    contractId: `contract-${actionId}`,
    approvalRef: `approval-${actionId}`,
    authorityExpiresAt: now + 120_000,
    now,
  });
}

function receiptArgs(actionId = "action-1", status = "succeeded") {
  return {
    serviceToken: SERVICE_TOKEN,
    receiptKey: `receipt-key-${actionId}`,
    receiptId: `receipt-${actionId}`,
    actionId,
    requestId: `request-${actionId}`,
    projectId: PROJECT_KEY,
    idempotencyKey: `execution-${actionId}`,
    actionFingerprint: `fingerprint-${actionId}`,
    tool: "quotes",
    operation: "send",
    actor: "tool",
    approvalId: `approval-${actionId}`,
    policyVersion: "omega-sigma:v1",
    correlationId: `correlation-${actionId}`,
    source: "omega-runtime-test",
    status,
    startedAt: 10_200,
    completedAt: 10_300,
  };
}

async function saveReceiptAndDrainScheduled(
  t: ReturnType<typeof harness>,
  args: ReturnType<typeof receiptArgs>,
) {
  vi.useFakeTimers();
  try {
    const receipt = await t.mutation(anyApi.toolExecutionReceipts.save, args);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    return receipt;
  } finally {
    vi.useRealTimers();
  }
}

describe("Omega mission creation", () => {
  it("rejects pre-satisfied acceptance criteria", async () => {
    const t = harness();
    await t.run((ctx) => seedProject(ctx));

    await expect(
      t.mutation(anyApi.omegaMissions.create, {
        serviceToken: SERVICE_TOKEN,
        missionId: "mission-pre-satisfied",
        projectKey: PROJECT_KEY,
        objective: "Should fail.",
        riskClass: "R1",
        autonomyClass: "A1",
        reversibilityClass: "REV-1",
        uncertaintyBudget: 0.2,
        acceptanceCriteria: [
          {
            criterionId: "AC-1",
            statement: "Already claimed complete.",
            status: "satisfied",
            evidenceRefs: ["missing-evidence"],
          },
        ],
      }),
    ).rejects.toThrow(/start unverified/i);
  });
});

describe("Omega action contracts", () => {
  it("rejects reusable governed actions in Pass 2", async () => {
    const t = harness();
    await t.run((ctx) => seedProject(ctx));
    await createActiveMission(t);

    await t.mutation(anyApi.toolActions.stage, {
      serviceToken: SERVICE_TOKEN,
      actionId: "reusable-action",
      requestId: "request-reusable",
      projectKey: PROJECT_KEY,
      expectedRevision: 1,
      tool: "notes",
      operation: "create",
      arguments: { title: "Safe note" },
      rationale: "Prove reusable actions are not silently made one-shot.",
      requiredAuthority: "T2",
      destructive: false,
      idempotencyKey: "idempotency-reusable",
      proposedBy: "agent",
    });
    await t.mutation(anyApi.toolActions.approve, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "reusable-action",
      expectedRevision: 1,
      now: 10_000,
    });

    await expect(
      t.mutation(anyApi.omegaActionContracts.create, {
        serviceToken: SERVICE_TOKEN,
        missionId: "mission-1",
        contractId: "contract-reusable",
        toolActionId: "reusable-action",
        intent: "Must be rejected in Pass 2.",
        riskClass: "R1",
        reversibilityClass: "REV-1",
        requiredAuthority: "T2",
        scope: { projectKey: PROJECT_KEY },
        preconditions: [],
      }),
    ).rejects.toThrow(/single-use/i);
  });

  it("clamps Omega authority to the underlying Jarvis approval expiry", async () => {
    const t = harness();
    await t.run((ctx) => seedProject(ctx));
    await createActiveMission(t);
    const approved = await stageAndApproveDestructiveAction(t);
    const contract = await bindAndAuthorize(t);

    expect(contract.status).toBe("authorized");
    expect(contract.authorityExpiresAt).toBe(approved.approvalExpiresAt);
  });
});

describe("Omega atomic execution gate", () => {
  it("blocks a bound action while its mission is blocked without consuming it", async () => {
    const t = harness();
    await t.run((ctx) => seedProject(ctx));
    await createActiveMission(t);
    await stageAndApproveDestructiveAction(t);
    await bindAndAuthorize(t);
    await t.mutation(anyApi.omegaMissions.transition, {
      serviceToken: SERVICE_TOKEN,
      missionId: "mission-1",
      nextState: "blocked",
    });

    const claim = await t.mutation(anyApi.toolActions.claimSingleUseExecution, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      claimId: "claim-blocked",
      now: 10_200,
    });

    expect(claim).toEqual({
      claimed: false,
      claimId: "",
      blockReason: "omega-mission-not-executable",
    });
    const action = await t.run((ctx) =>
      ctx.db
        .query("toolActions")
        .withIndex("by_owner_and_action_id", (q) =>
          q.eq("ownerId", OWNER_ID).eq("actionId", "action-1"),
        )
        .unique(),
    );
    expect(action?.singleUseClaimId).toBeUndefined();
  });

  it("atomically claims both Jarvis action and Omega contract when authorized", async () => {
    const t = harness();
    await t.run((ctx) => seedProject(ctx));
    await createActiveMission(t);
    await stageAndApproveDestructiveAction(t);
    await bindAndAuthorize(t);

    const claim = await t.mutation(anyApi.toolActions.claimSingleUseExecution, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      claimId: "claim-1",
      now: 10_200,
    });
    expect(claim).toEqual({ claimed: true, claimId: "claim-1" });

    const contract = await t.query(anyApi.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: "action-1",
    });
    expect(contract?.status).toBe("claimed");
  });
});

describe("Omega receipt reconciliation", () => {
  it("turns a terminal receipt into durable mission evidence and reconciles exactly once", async () => {
    const t = harness();
    await t.run((ctx) => seedProject(ctx));
    await createActiveMission(t);
    await stageAndApproveDestructiveAction(t);
    await bindAndAuthorize(t);
    await t.mutation(anyApi.toolActions.claimSingleUseExecution, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-1",
      claimId: "claim-1",
      now: 10_200,
    });

    const first = await saveReceiptAndDrainScheduled(t, receiptArgs());
    const second = await saveReceiptAndDrainScheduled(t, receiptArgs());
    expect(second._id).toBe(first._id);

    const contract = await t.query(anyApi.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: "action-1",
    });
    expect(contract?.status).toBe("reconciled");

    const evidence = await t.run((ctx) =>
      ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q
            .eq("ownerId", OWNER_ID)
            .eq("missionId", "mission-1")
            .eq("evidenceId", "tool-receipt:receipt-key-action-1"),
        )
        .unique(),
    );
    expect(evidence?.claim).toMatch(/succeeded/i);
  });

  it("records an indeterminate receipt as indeterminate rather than inferred success", async () => {
    const t = harness();
    await t.run((ctx) => seedProject(ctx));
    await createActiveMission(t, "mission-indeterminate");
    await stageAndApproveDestructiveAction(t, "action-indeterminate");
    await bindAndAuthorize(t, "mission-indeterminate", "action-indeterminate");
    await t.mutation(anyApi.toolActions.claimSingleUseExecution, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: "action-indeterminate",
      claimId: "claim-indeterminate",
      now: 10_200,
    });
    await saveReceiptAndDrainScheduled(t, receiptArgs("action-indeterminate", "indeterminate"));

    const evidence = await t.run((ctx) =>
      ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q
            .eq("ownerId", OWNER_ID)
            .eq("missionId", "mission-indeterminate")
            .eq("evidenceId", "tool-receipt:receipt-key-action-indeterminate"),
        )
        .unique(),
    );
    expect(evidence?.claim).toMatch(/indeterminate/i);
    expect(evidence?.claim).not.toMatch(/succeeded/i);
  });
});
