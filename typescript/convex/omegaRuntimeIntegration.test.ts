import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "omega-runtime-integration-service-token-0000";
const OWNER_ID = "jarvis-cli";
const PROJECT_KEY = "omega-project";
const MISSION_ID = "omega-mission-1";
const ACTION_ID = "omega-action-1";
const CONTRACT_ID = "omega-contract-1";

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
    projectName: "Omega runtime integration",
    projectType: "test",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
    domains: ["business"],
    summary: "Omega integration test project.",
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
  await t.mutation(api.omegaMissions.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    projectKey: PROJECT_KEY,
    objective: "Prove governed external execution feeds durable mission evidence.",
    riskClass: "R3",
    autonomyClass: "A3",
    reversibilityClass: "REV-3",
    uncertaintyBudget: 0.2,
    acceptanceCriteria: [
      {
        criterionId: "AC-1",
        statement: "The governed external action is reconciled and independently validated.",
        status: "unverified",
        evidenceRefs: [],
      },
    ],
  });
  return t.mutation(api.omegaMissions.transition, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    nextState: "active",
  });
}

async function stageDestructiveAction(t: ReturnType<typeof harness>) {
  return t.mutation(api.toolActions.stage, {
    serviceToken: SERVICE_TOKEN,
    actionId: ACTION_ID,
    requestId: "omega-request-1",
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    tool: "outlook",
    operation: "send",
    arguments: { draftId: "draft-123" },
    rationale: "Exercise the governed external effect boundary.",
    requiredAuthority: "T3",
    destructive: true,
    idempotencyKey: "omega-action-idempotency-1",
    proposedBy: "agent",
  });
}

async function createContract(t: ReturnType<typeof harness>) {
  return t.mutation(api.omegaActionContracts.create, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    contractId: CONTRACT_ID,
    toolActionId: ACTION_ID,
    intent: "Send the approved external message exactly once.",
    riskClass: "R3",
    reversibilityClass: "REV-3",
    preconditionEvidenceRefs: [],
    rollbackPlan: "Escalate for reconciliation; never duplicate-send.",
  });
}

async function approveAndAuthorize(t: ReturnType<typeof harness>) {
  const approved = await t.mutation(api.toolActions.approve, {
    serviceToken: SERVICE_TOKEN,
    projectKey: PROJECT_KEY,
    actionId: ACTION_ID,
    expectedRevision: 1,
  });
  const contract = await t.mutation(api.omegaActionContracts.authorize, {
    serviceToken: SERVICE_TOKEN,
    missionId: MISSION_ID,
    contractId: CONTRACT_ID,
  });
  return { approved, contract };
}

async function claimAction(t: ReturnType<typeof harness>, claimId = "omega-claim-1") {
  return t.mutation(api.toolActions.claimSingleUseExecution, {
    serviceToken: SERVICE_TOKEN,
    projectKey: PROJECT_KEY,
    actionId: ACTION_ID,
    claimId,
  });
}

function receiptInput(status: "succeeded" | "failed" | "indeterminate", completedAt: number) {
  return {
    receiptId: "omega-receipt-1",
    actionId: ACTION_ID,
    requestId: "omega-request-1",
    projectId: PROJECT_KEY,
    idempotencyKey: "omega-execution-idempotency-1",
    actionFingerprint: "omega-action-fingerprint-1",
    effectFingerprint: "omega-effect-fingerprint-1",
    tool: "outlook",
    operation: "send",
    actor: "tool" as const,
    policyVersion: "omega-test-policy:v1",
    correlationId: "omega-correlation-1",
    source: "omega-runtime-test",
    provider: "microsoft-graph",
    providerRequestId: "provider-request-1",
    providerCorrelationId: "provider-correlation-1",
    status,
    ...(status === "failed" ? { errorCode: "provider-failed" as const } : {}),
    startedAt: completedAt - 10,
    completedAt,
  };
}

describe("Omega runtime integration", () => {
  it("requires existing Jarvis approval before an Omega contract can authorize", async () => {
    const t = harness();
    await createActiveMission(t);
    await stageDestructiveAction(t);
    await createContract(t);

    await expect(
      t.mutation(api.omegaActionContracts.authorize, {
        serviceToken: SERVICE_TOKEN,
        missionId: MISSION_ID,
        contractId: CONTRACT_ID,
      }),
    ).rejects.toThrow(/approved/i);
  });

  it("blocks the same atomic single-use claim when its Omega mission is not executable", async () => {
    const t = harness();
    await createActiveMission(t);
    await stageDestructiveAction(t);
    await createContract(t);
    await approveAndAuthorize(t);
    await t.mutation(api.omegaMissions.transition, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
      nextState: "blocked",
    });

    const claim = await claimAction(t);
    expect(claim).toEqual({
      claimed: false,
      claimId: "",
      blockReason: "omega-mission-not-executable",
    });

    const action = await t.query(api.toolActions.get, {
      serviceToken: SERVICE_TOKEN,
      projectKey: PROJECT_KEY,
      actionId: ACTION_ID,
    });
    expect(action?.singleUseClaimId).toBeUndefined();

    const contract = await t.query(api.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: ACTION_ID,
    });
    expect(contract?.status).toBe("authorized");
  });

  it("reconciles a direct terminal Jarvis receipt into durable Omega evidence", async () => {
    const t = harness();
    await createActiveMission(t);
    await stageDestructiveAction(t);
    await createContract(t);
    await approveAndAuthorize(t);

    const claim = await claimAction(t);
    expect(claim.claimed).toBe(true);

    const completedAt = Date.now();
    await t.mutation(api.toolExecutionReceipts.save, {
      serviceToken: SERVICE_TOKEN,
      receiptKey: "omega-receipt-key-1",
      ...receiptInput("succeeded", completedAt),
    });

    const contract = await t.query(api.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: ACTION_ID,
    });
    expect(contract?.status).toBe("reconciled");
    expect(contract?.terminalOutcome).toBe("succeeded");
    expect(contract?.reconciledReceiptKey).toBe("omega-receipt-key-1");

    const evidence = await t.run((ctx) =>
      ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q
            .eq("ownerId", OWNER_ID)
            .eq("missionId", MISSION_ID)
            .eq("evidenceId", "tool-receipt:omega-receipt-key-1:succeeded"),
        )
        .unique(),
    );
    expect(evidence?.classification).toBe("certain");
    expect(evidence?.sourceType).toBe("direct-measurement");
  });

  it("keeps an indeterminate external effect unresolved until Jarvis reconciliation resolves it", async () => {
    const t = harness();
    await createActiveMission(t);

    await t.mutation(api.omegaMissions.recordEvidence, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
      evidenceId: "independent-proof-1",
      claim: "Independent validation confirms the intended outcome boundary.",
      classification: "certain",
      sourceType: "independent-verification",
      sourceRef: "omega-runtime-test",
      contradicts: [],
    });
    await t.mutation(api.omegaMissions.recordValidationProof, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
      proofId: "proof-1",
      criterionId: "AC-1",
      method: "independent",
      result: "pass",
      independent: true,
      evidenceRefs: ["independent-proof-1"],
      performedBy: "omega-runtime-test",
    });

    await stageDestructiveAction(t);
    await createContract(t);
    await approveAndAuthorize(t);
    const claim = await claimAction(t);
    expect(claim.claimed).toBe(true);

    const scope = {
      projectId: PROJECT_KEY,
      tool: "outlook",
      operation: "send",
      idempotencyKey: "omega-execution-idempotency-1",
      effectFingerprint: "omega-effect-fingerprint-1",
    };
    await t.mutation(api.externalReconciliations.registerAttempt, {
      serviceToken: SERVICE_TOKEN,
      ...scope,
      reconciliationId: "omega-reconciliation-1",
      executionKey: "omega-execution-key-1",
      actionId: ACTION_ID,
      requestId: "omega-request-1",
      actionFingerprint: "omega-action-fingerprint-1",
      provider: "microsoft-graph",
      providerRequestId: "provider-request-1",
      providerCorrelationId: "provider-correlation-1",
    });

    const indeterminateAt = Date.now();
    await t.mutation(api.externalReconciliations.markIndeterminate, {
      serviceToken: SERVICE_TOKEN,
      ...scope,
      reconciliationId: "omega-reconciliation-1",
      executionKey: "omega-execution-key-1",
      actionId: ACTION_ID,
      requestId: "omega-request-1",
      actionFingerprint: "omega-action-fingerprint-1",
      expectedProvider: "microsoft-graph",
      receiptKey: "omega-receipt-key-1",
      receipt: receiptInput("indeterminate", indeterminateAt),
    });

    let contract = await t.query(api.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: ACTION_ID,
    });
    expect(contract?.status).toBe("indeterminate");

    await t.mutation(api.omegaMissions.transition, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
      nextState: "validating",
    });
    await expect(
      t.mutation(api.omegaMissions.transition, {
        serviceToken: SERVICE_TOKEN,
        missionId: MISSION_ID,
        nextState: "complete",
        residualUncertainty: 0.1,
      }),
    ).rejects.toThrow(/action-contracts-unresolved/);

    const claimNow = indeterminateAt + 100;
    const reconciliationClaim = await t.mutation(api.externalReconciliations.claimNext, {
      serviceToken: SERVICE_TOKEN,
      workerId: "omega-worker-1",
      leaseToken: "omega-lease-1",
      now: claimNow,
      leaseMs: 60_000,
    });
    expect(reconciliationClaim?.reconciliation.reconciliationId).toBe("omega-reconciliation-1");

    await t.mutation(api.externalReconciliations.resolveClaim, {
      serviceToken: SERVICE_TOKEN,
      reconciliationId: "omega-reconciliation-1",
      workerId: "omega-worker-1",
      leaseToken: "omega-lease-1",
      now: claimNow + 100,
      result: { status: "succeeded", outputDigest: "omega-output-digest-1" },
    });

    contract = await t.query(api.omegaActionContracts.getByToolAction, {
      serviceToken: SERVICE_TOKEN,
      toolActionId: ACTION_ID,
    });
    expect(contract?.status).toBe("reconciled");
    expect(contract?.terminalOutcome).toBe("succeeded");

    const completed = await t.mutation(api.omegaMissions.transition, {
      serviceToken: SERVICE_TOKEN,
      missionId: MISSION_ID,
      nextState: "complete",
      residualUncertainty: 0.1,
    });
    expect(completed.state).toBe("complete");
  });
});
