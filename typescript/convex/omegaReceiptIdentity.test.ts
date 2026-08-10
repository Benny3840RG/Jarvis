import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-receipt-identity-service-token";
const OWNER_ID = "jarvis-cli";
const PROJECT_KEY = "omega-receipt-project";
const MISSION_ID = "omega-receipt-mission";
const ACTION_ID = "omega-receipt-action";
const CONTRACT_ID = "omega-receipt-contract";

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
    projectName: "Omega receipt identity",
    projectType: "test",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
    domains: ["business"],
    summary: "Omega receipt identity test project.",
    preferences: {
      outputStyle: "concise",
      communicationTone: "neutral",
      detailLevel: "standard",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
}

async function setupClaimedContract(t: ReturnType<typeof harness>) {
  await t.run((ctx) => seedProject(ctx));
  await t.mutation(api.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    projectKey: PROJECT_KEY,
    objective: "Reject receipts that do not identify the bound governed action.",
    riskClass: "R3",
    autonomyClass: "A3",
    reversibilityClass: "REV-3",
    uncertaintyBudget: 0.2,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "Only the authoritative bound action receipt can reconcile this mission.",
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
  await t.mutation(api.toolActions.stage, {
    serviceToken: SERVICE_TOKEN,
    actionId: ACTION_ID,
    requestId: "omega-receipt-request",
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    tool: "outlook",
    operation: "send",
    arguments: { draftId: "draft-identity-1" },
    rationale: "Exercise receipt identity validation.",
    requiredAuthority: "T3",
    destructive: true,
    idempotencyKey: "omega-receipt-action-idempotency",
    proposedBy: "agent",
  });
  await t.mutation(api.omegaActionContracts.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    contractId: CONTRACT_ID,
    toolActionId: ACTION_ID,
    intent: "Send the approved Outlook draft exactly once.",
    riskClass: "R3",
    reversibilityClass: "REV-3",
    preconditionEvidenceRefs: [],
    rollbackPlan: "Escalate for reconciliation; never duplicate-send.",
  });
  await t.mutation(api.toolActions.approve, {
    serviceToken: SERVICE_TOKEN,
    projectKey: PROJECT_KEY,
    actionId: ACTION_ID,
    expectedRevision: 1,
  });
  await t.mutation(api.omegaActionContracts.authorize, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    contractId: CONTRACT_ID,
  });
  const claim = await t.mutation(api.toolActions.claimSingleUseExecution, {
    serviceToken: SERVICE_TOKEN,
    projectKey: PROJECT_KEY,
    actionId: ACTION_ID,
    claimId: "omega-receipt-claim",
  });
  expect(claim.claimed).toBe(true);
}

describe("Omega receipt identity", () => {
  it("fails closed when a terminal receipt tool identity does not match the bound action", async () => {
    const t = harness();
    await setupClaimedContract(t);

    const completedAt = Date.now();
    await t.mutation(api.toolExecutionReceipts.save, {
      serviceToken: SERVICE_TOKEN,
      receiptKey: "omega-receipt-key-mismatch",
      receiptId: "omega-receipt-id-mismatch",
      actionId: ACTION_ID,
      requestId: "omega-receipt-request",
      projectId: PROJECT_KEY,
      idempotencyKey: "omega-receipt-execution-idempotency",
      actionFingerprint: "omega-receipt-action-fingerprint",
      effectFingerprint: "omega-receipt-effect-fingerprint",
      tool: "gmail",
      operation: "send",
      actor: "tool",
      policyVersion: "omega-test-policy:v1",
      correlationId: "omega-receipt-correlation",
      source: "omega-receipt-test",
      provider: "microsoft-graph",
      status: "succeeded",
      startedAt: completedAt - 10,
      completedAt,
    });

    const contract = await t.query(api.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: ACTION_ID,
    });
    expect(contract?.status).toBe("conflicted");
    expect(contract?.terminalOutcome).toBeUndefined();
    expect(contract?.reconciledReceiptKey).toBeUndefined();

    const evidence = await t.run((ctx) =>
      ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q
            .eq("ownerId", OWNER_ID)
            .eq("missionId", MISSION_ID)
            .eq("evidenceId", "tool-receipt:omega-receipt-key-mismatch:succeeded"),
        )
        .unique(),
    );
    expect(evidence).toBeNull();
  });
});
