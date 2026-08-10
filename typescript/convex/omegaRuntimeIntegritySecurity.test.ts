import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-integrity-service-token-000000000000";
const APPROVAL_TOKEN = "omega-integrity-approval-token-00000000000";
const OWNER_ID = "jarvis-cli";
const PROJECT_KEY = "omega-integrity-project";
const MISSION_ID = "omega-integrity-mission";
const ACTION_ID = "omega-integrity-action";
const CONTRACT_ID = "omega-integrity-contract";

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
    projectName: "Omega runtime integrity",
    projectType: "test",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 1,
    domains: ["business"],
    summary: "Omega runtime integrity regression project.",
    preferences: {
      outputStyle: "concise",
      communicationTone: "neutral",
      detailLevel: "standard",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
}

async function createActiveMission(t: ReturnType<typeof harness>) {
  await t.run((ctx) => seedProject(ctx));
  await t.mutation(anyApi.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    projectKey: PROJECT_KEY,
    objective: "Preserve evidence and reconcile only authoritative external truth.",
    riskClass: "R3",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.2,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "The governed action remains evidence-backed and correctly reconciled.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
  await t.mutation(anyApi.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    nextState: "active",
  });
}

async function setupClaimedContract(t: ReturnType<typeof harness>) {
  await createActiveMission(t);
  await t.mutation(anyApi.toolActions.stage, {
    serviceToken: SERVICE_TOKEN,
    actionId: ACTION_ID,
    requestId: "omega-integrity-request",
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    tool: "outlook",
    operation: "send",
    arguments: { draftId: "draft-integrity-1" },
    rationale: "Exercise the governed external reconciliation boundary.",
    requiredAuthority: "T3",
    destructive: true,
    idempotencyKey: "omega-integrity-action-idempotency",
    proposedBy: "agent",
  });
  await t.mutation(anyApi.toolActions.approve, {
    serviceToken: SERVICE_TOKEN,
    approvalToken: APPROVAL_TOKEN,
    projectKey: PROJECT_KEY,
    actionId: ACTION_ID,
    expectedRevision: 1,
    now: 10_000,
    approvalTtlMs: 60_000,
  });
  await t.mutation(anyApi.omegaActionContracts.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    contractId: CONTRACT_ID,
    toolActionId: ACTION_ID,
    intent: "Send the approved Outlook draft exactly once.",
    riskClass: "R3",
    reversibilityClass: "REV-2",
    requiredAuthority: "T3",
    scope: { projectKey: PROJECT_KEY },
    preconditions: ["underlying-action-approved"],
    rollbackPlan: "Reconcile terminal provider truth without duplicate send.",
  });
  await t.mutation(anyApi.omegaActionContracts.authorize, {
    serviceToken: SERVICE_TOKEN,
    approvalToken: APPROVAL_TOKEN,
    missionId: MISSION_ID,
    contractId: CONTRACT_ID,
    approvalRef: "approval-integrity",
    now: 10_100,
  });
  const claim = await t.mutation(anyApi.toolActions.claimSingleUseExecution, {
    serviceToken: SERVICE_TOKEN,
    projectKey: PROJECT_KEY,
    actionId: ACTION_ID,
    claimId: "omega-integrity-claim",
    now: 10_200,
  });
  expect(claim.claimed).toBe(true);
}

function receiptInput(status: "succeeded" | "failed" | "indeterminate", completedAt: number) {
  return {
    receiptId: "omega-integrity-receipt",
    actionId: ACTION_ID,
    requestId: "omega-integrity-request",
    projectId: PROJECT_KEY,
    idempotencyKey: "omega-integrity-execution-idempotency",
    actionFingerprint: "omega-integrity-action-fingerprint",
    effectFingerprint: "omega-integrity-effect-fingerprint",
    tool: "outlook",
    operation: "send",
    actor: "tool" as const,
    approvalId: "approval-integrity",
    policyVersion: "omega-sigma:v1",
    correlationId: "omega-integrity-correlation",
    source: "omega-runtime-integrity-test",
    provider: "microsoft-graph",
    providerRequestId: "provider-request-integrity",
    providerCorrelationId: "provider-correlation-integrity",
    status,
    ...(status === "failed" ? { errorCode: "provider-failed" as const } : {}),
    startedAt: completedAt - 10,
    completedAt,
  };
}

async function drainScheduled(t: ReturnType<typeof harness>) {
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
}

describe("Omega runtime integrity", () => {
  it("accumulates criterion evidence instead of replacing earlier passing-proof evidence", async () => {
    const t = harness();
    await createActiveMission(t);

    for (const evidenceId of ["EV-independent", "EV-corroborating"]) {
      await t.mutation(anyApi.omegaMissions.recordEvidence, {
        serviceToken: SERVICE_TOKEN,
        missionId: MISSION_ID,
        evidenceId,
        claim: `Evidence ${evidenceId} supports AC-1.`,
        classification: "certain",
        sourceType:
          evidenceId === "EV-independent" ? "independent-verification" : "direct-measurement",
        sourceRef: "omega-integrity-test",
        contradicts: [],
      });
    }

    await t.mutation(anyApi.omegaMissions.recordValidationProof, {
      serviceToken: SERVICE_TOKEN,
      approvalToken: APPROVAL_TOKEN,
      missionId: MISSION_ID,
      proofId: "proof-independent",
      criterionId: "AC-1",
      method: "independent",
      result: "pass",
      independent: true,
      evidenceRefs: ["EV-independent"],
      performedBy: "independent-reviewer",
    });
    await t.mutation(anyApi.omegaMissions.recordValidationProof, {
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

    const mission = await t.query(anyApi.omegaMissions.get, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
    });
    expect(mission?.acceptanceCriteria[0]?.evidenceRefs).toEqual([
      "EV-independent",
      "EV-corroborating",
    ]);
  });

  it("fails closed when a terminal receipt identity does not match the bound action", async () => {
    const t = harness();
    await setupClaimedContract(t);

    vi.useFakeTimers();
    const completedAt = 10_300;
    await t.mutation(anyApi.toolExecutionReceipts.save, {
      serviceToken: SERVICE_TOKEN,
      receiptKey: "omega-integrity-receipt-key-mismatch",
      ...receiptInput("succeeded", completedAt),
      tool: "gmail",
    });
    await drainScheduled(t);

    const contract = await t.query(anyApi.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: ACTION_ID,
    });
    expect(contract?.status).toBe("conflicted");

    const evidence = await t.run((ctx) =>
      ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q
            .eq("ownerId", OWNER_ID)
            .eq("missionId", MISSION_ID)
            .eq("evidenceId", "tool-receipt:omega-integrity-receipt-key-mismatch:succeeded"),
        )
        .unique(),
    );
    expect(evidence).toBeNull();
  });

  it("keeps an indeterminate worker outcome unresolved until authoritative reconciliation resolves it", async () => {
    const t = harness();
    await setupClaimedContract(t);

    const scope = {
      projectId: PROJECT_KEY,
      tool: "outlook",
      operation: "send",
      idempotencyKey: "omega-integrity-execution-idempotency",
      effectFingerprint: "omega-integrity-effect-fingerprint",
    };
    await t.mutation(anyApi.externalReconciliations.registerAttempt, {
      serviceToken: SERVICE_TOKEN,
      ...scope,
      reconciliationId: "omega-integrity-reconciliation",
      executionKey: "omega-integrity-execution-key",
      actionId: ACTION_ID,
      requestId: "omega-integrity-request",
      actionFingerprint: "omega-integrity-action-fingerprint",
      provider: "microsoft-graph",
      providerRequestId: "provider-request-integrity",
      providerCorrelationId: "provider-correlation-integrity",
    });

    vi.useFakeTimers();
    await t.mutation(anyApi.externalReconciliations.markIndeterminate, {
      serviceToken: SERVICE_TOKEN,
      ...scope,
      reconciliationId: "omega-integrity-reconciliation",
      executionKey: "omega-integrity-execution-key",
      actionId: ACTION_ID,
      requestId: "omega-integrity-request",
      actionFingerprint: "omega-integrity-action-fingerprint",
      expectedProvider: "microsoft-graph",
      receiptKey: "omega-integrity-receipt-key",
      receipt: receiptInput("indeterminate", 10_300),
    });
    await drainScheduled(t);

    let contract = await t.query(anyApi.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: ACTION_ID,
    });
    expect(contract?.status).toBe("indeterminate");

    const reconciliationClaim = await t.mutation(anyApi.externalReconciliations.claimNext, {
      serviceToken: SERVICE_TOKEN,
      workerId: "omega-integrity-worker",
      leaseToken: "omega-integrity-lease",
      now: 10_400,
      leaseMs: 60_000,
    });
    expect(reconciliationClaim?.reconciliation.reconciliationId).toBe(
      "omega-integrity-reconciliation",
    );

    await t.mutation(anyApi.externalReconciliations.resolveClaim, {
      serviceToken: SERVICE_TOKEN,
      reconciliationId: "omega-integrity-reconciliation",
      workerId: "omega-integrity-worker",
      leaseToken: "omega-integrity-lease",
      now: 10_500,
      result: { status: "succeeded", outputDigest: "omega-integrity-output-digest" },
    });
    await drainScheduled(t);

    contract = await t.query(anyApi.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: ACTION_ID,
    });
    expect(contract?.status).toBe("reconciled");
    expect(contract?.terminalOutcome).toBe("succeeded");
    expect(contract?.reconciledReceiptKey).toBe("omega-integrity-receipt-key");
  });
});
