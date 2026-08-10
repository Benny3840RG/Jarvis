import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-authorization-service-token-000000";
const APPROVAL_TOKEN = "omega-authorization-approval-token-000000";
const OWNER_ID = "jarvis-cli";
const PROJECT_KEY = "omega-authorization-project";

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
    projectName: "Omega authorization security",
    projectType: "test",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 1,
    domains: ["business"],
    summary: "Omega authorization must preserve the human approval boundary.",
    preferences: {
      outputStyle: "concise",
      communicationTone: "neutral",
      detailLevel: "standard",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
}

async function seedProposedContract(t: ReturnType<typeof harness>) {
  await t.run((ctx) => seedProject(ctx));
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-authorization",
    projectKey: PROJECT_KEY,
    objective: "Keep Omega authorization behind the human credential boundary.",
    riskClass: "R3",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.2,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "Authorization requires the dedicated approval credential.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-authorization",
    nextState: "active",
  });
  await t.mutation(anyApi.toolActions.stage, {
    serviceToken: SERVICE_TOKEN,
    actionId: "action-authorization",
    requestId: "request-authorization",
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    tool: "quotes",
    operation: "send",
    arguments: { quoteId: "quote-authorization" },
    rationale: "Exercise the Omega authorization boundary.",
    requiredAuthority: "T3",
    destructive: true,
    idempotencyKey: "idempotency-authorization",
    proposedBy: "agent",
  });
  await t.mutation(anyApi.toolActions.approve, {
    serviceToken: SERVICE_TOKEN,
    approvalToken: APPROVAL_TOKEN,
    projectKey: PROJECT_KEY,
    actionId: "action-authorization",
    expectedRevision: 1,
    now: 10_000,
    approvalTtlMs: 60_000,
  });
  await t.mutation(anyApi.omegaActionContracts.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: "mission-authorization",
    contractId: "contract-authorization",
    toolActionId: "action-authorization",
    intent: "Authorize the approved one-shot action.",
    riskClass: "R3",
    reversibilityClass: "REV-2",
    requiredAuthority: "T3",
    scope: { projectKey: PROJECT_KEY },
    preconditions: ["underlying-action-approved"],
    rollbackPlan: "Reconcile terminal outcome without duplicate effect.",
  });
}

describe("Omega contract authorization security", () => {
  it("rejects a service-token-only caller that bypasses the human approval credential", async () => {
    const t = harness();
    await seedProposedContract(t);

    await expect(
      t.mutation(anyApi.omegaActionContracts.authorize, {
        serviceToken: SERVICE_TOKEN,
        missionId: "mission-authorization",
        contractId: "contract-authorization",
        approvalRef: "approval-authorization",
        now: 10_100,
      }),
    ).rejects.toThrow(/approval token/i);
  });
});
