import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-receipt-isolation-service-token-0000";
const APPROVAL_TOKEN = "omega-receipt-isolation-approval-token-000";
const OWNER_ID = "jarvis-cli";
const PROJECT_KEY = "omega-receipt-isolation-project";

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
  await ctx.db.insert("projects", {
    ownerId: OWNER_ID,
    projectKey: PROJECT_KEY,
    projectName: "Omega receipt isolation",
    projectType: "test",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 1,
    domains: ["business"],
    summary: "Receipt durability must outrank auxiliary Omega reconciliation.",
    preferences: {
      outputStyle: "concise",
      communicationTone: "neutral",
      detailLevel: "standard",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
}

async function seedAuthorizedButUnclaimedContract(t: ReturnType<typeof harness>) {
  await t.run((ctx) => seedProject(ctx));
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-isolation",
    projectKey: PROJECT_KEY,
    objective: "Preserve the authoritative execution receipt.",
    riskClass: "R3",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.2,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "A terminal receipt is durable even if Omega cannot reconcile it yet.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-isolation",
    nextState: "active",
  });
  await t.mutation(anyApi.toolActions.stage, {
    serviceToken: SERVICE_TOKEN,
    actionId: "action-isolation",
    requestId: "request-isolation",
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    tool: "quotes",
    operation: "send",
    arguments: { quoteId: "quote-isolation" },
    rationale: "Exercise receipt isolation.",
    requiredAuthority: "T3",
    destructive: true,
    idempotencyKey: "idempotency-isolation",
    proposedBy: "agent",
  });
  await t.mutation(anyApi.toolActions.approve, {
    serviceToken: SERVICE_TOKEN,
    approvalToken: APPROVAL_TOKEN,
    projectKey: PROJECT_KEY,
    actionId: "action-isolation",
    expectedRevision: 1,
    now: 10_000,
    approvalTtlMs: 60_000,
  });
  await t.mutation(anyApi.omegaActionContracts.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-isolation",
    contractId: "contract-isolation",
    toolActionId: "action-isolation",
    intent: "Preserve execution truth before mission reconciliation.",
    riskClass: "R3",
    reversibilityClass: "REV-2",
    requiredAuthority: "T3",
    scope: { projectKey: PROJECT_KEY },
    preconditions: ["underlying-action-approved"],
    rollbackPlan: "Reconcile later without deleting execution evidence.",
  });
  await t.mutation(anyApi.omegaActionContracts.authorize, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-isolation",
    contractId: "contract-isolation",
    approvalRef: "approval-isolation",
    now: 10_100,
  });
}

function receiptArgs() {
  return {
    serviceToken: SERVICE_TOKEN,
    receiptKey: "receipt-key-isolation",
    receiptId: "receipt-isolation",
    actionId: "action-isolation",
    requestId: "request-isolation",
    projectId: PROJECT_KEY,
    idempotencyKey: "execution-isolation",
    actionFingerprint: "fingerprint-isolation",
    tool: "quotes",
    operation: "send",
    actor: "tool",
    approvalId: "approval-isolation",
    policyVersion: "omega-sigma:v1",
    correlationId: "correlation-isolation",
    source: "omega-receipt-isolation-test",
    status: "succeeded",
    startedAt: 10_200,
    completedAt: 10_300,
  };
}

async function drainScheduled(t: ReturnType<typeof harness>): Promise<unknown> {
  vi.useFakeTimers();
  try {
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    return undefined;
  } catch (error) {
    return error;
  } finally {
    vi.useRealTimers();
  }
}

describe("Omega receipt isolation", () => {
  it("persists Jarvis receipt when Omega reconciliation cannot advance", async () => {
    const t = harness();
    await seedAuthorizedButUnclaimedContract(t);

    const receipt = await t.mutation(anyApi.toolExecutionReceipts.save, receiptArgs());
    expect(receipt.receiptId).toBe("receipt-isolation");

    const scheduledFailure = await drainScheduled(t);
    expect(scheduledFailure).toBeUndefined();

    const stored = await t.query(anyApi.toolExecutionReceipts.get, {
      serviceToken: SERVICE_TOKEN,
      receiptKey: "receipt-key-isolation",
    });
    expect(stored?.receiptId).toBe("receipt-isolation");

    const contract = await t.query(anyApi.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: "action-isolation",
    });
    expect(contract?.status).toBe("authorized");
  });

  it("persists Jarvis receipt even when scheduled Omega reconciliation hits inconsistent indexed state", async () => {
    const t = harness();
    await seedAuthorizedButUnclaimedContract(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("omegaActionContracts", {
        ownerId: OWNER_ID,
        missionId: "mission-isolation",
        contractId: "contract-isolation-duplicate",
        toolActionId: "action-isolation",
        intent: "Deliberately corrupt the secondary Omega binding for isolation coverage.",
        riskClass: "R3",
        reversibilityClass: "REV-2",
        requiredAuthority: "T3",
        scope: { projectKey: PROJECT_KEY },
        preconditions: ["underlying-action-approved"],
        approvalRef: "approval-isolation-duplicate",
        status: "authorized",
        createdAt: 10_100,
        updatedAt: 10_100,
      });
    });

    const receipt = await t.mutation(anyApi.toolExecutionReceipts.save, receiptArgs());
    expect(receipt.receiptId).toBe("receipt-isolation");

    const storedBeforeReconciliation = await t.query(anyApi.toolExecutionReceipts.get, {
      serviceToken: SERVICE_TOKEN,
      receiptKey: "receipt-key-isolation",
    });
    expect(storedBeforeReconciliation?.receiptId).toBe("receipt-isolation");

    const scheduledFailure = await drainScheduled(t);
    if (scheduledFailure !== undefined) {
      expect(String(scheduledFailure)).toMatch(/unique|more than one/i);
    }

    const storedAfterReconciliation = await t.query(anyApi.toolExecutionReceipts.get, {
      serviceToken: SERVICE_TOKEN,
      receiptKey: "receipt-key-isolation",
    });
    expect(storedAfterReconciliation?.receiptId).toBe("receipt-isolation");
  });
});
