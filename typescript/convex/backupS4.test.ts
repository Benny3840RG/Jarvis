import { anyApi } from "convex/server";
import { jsonToConvex, type Value } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import type { Doc } from "./_generated/dataModel.js";
import { S4_TABLES, type S4Table, encodeS4Payload } from "../src/backup/v4/convexCapture.js";
const token = "s4-capture-owner-service-token-000000000";
const approvalToken = "s4-capture-approval-token-00000000000000";
beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", token);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", approvalToken);
});
afterEach(() => vi.unstubAllEnvs());
const fixtures = {
  projects: {
    projectKey: "p",
    projectName: "Project",
    projectType: "test",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    revision: 1,
    domains: [],
    summary: "",
    preferences: {
      outputStyle: "brief",
      communicationTone: "plain",
      detailLevel: "normal",
      unitSystem: "metric",
      locale: "en-AU",
    },
  },
  projectRecords: {
    projectKey: "p",
    kind: "fact",
    recordId: "fact",
    record: {
      kind: "fact",
      recordId: "fact",
      statement: "Observed",
      source: "user",
      confidence: 1,
      recordedAt: "2026-09-11T00:00:00Z",
    },
    updatedAt: 2,
  },
  notes: {
    projectId: "p",
    title: "Note",
    body: "Private preserved text",
    tags: [],
    domain: "workshop",
    sensitivity: "private",
    retention: "long_term",
    idempotencyKey: "note-key",
    actionFingerprint: "note-fingerprint",
    sourceRequestId: "note-request",
    correlationId: "correlation",
    source: "test",
    revision: 3,
    createdAt: 1,
    updatedAt: 2,
  },
  developmentEvents: {
    subjectId: "s",
    eventId: "event",
    requestId: "request",
    canonicalRequestFingerprint: "request-fingerprint",
    canonicalEventFingerprint: "event-fingerprint",
    eventType: "DEV_TRANSITION_COMMITTED",
    eventSchemaVersion: 1,
    occurredAt: "2026-09-11T00:00:00Z",
    recordedAt: "2026-09-11T00:00:00Z",
    evidenceIds: [],
    correlationId: "correlation",
    reducerVersion: "DevelopmentReducer/v1",
    payload: { to: "MERGED" },
    createdAt: 1,
  },
  developmentSubjects: {
    subjectId: "s",
    state: "MERGED",
    subjectVersion: 1,
    projectionVersion: 1,
    reducerVersion: "DevelopmentReducer/v1",
    omegaMissionId: "mission",
    orchestrationRunId: "run",
    orchestrationNodeId: "node",
    createdAt: 1,
    updatedAt: 2,
  },
  runtimeEvents: {
    eventId: "runtime",
    sequence: 1,
    eventType: "runtime",
    correlationId: "correlation",
    metadata: {
      counter: 123n,
      bytes: new Uint8Array([0, 255]).buffer,
      notFinite: Infinity,
      negativeZero: -0,
    },
    occurredAt: 1,
    createdAt: 1,
  },
  toolActions: {
    actionId: "action",
    requestId: "request",
    projectKey: "p",
    baseRevision: 1,
    state: "approved",
    tool: "notes",
    operation: "create",
    arguments: { title: "Note" },
    rationale: "test",
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: "action-key",
    proposedBy: "agent",
    createdAt: 1,
    updatedAt: 2,
    approvedBy: "user",
    approvedAt: 1,
    approvalExpiryPolicy: "ttl",
    approvalExpiresAt: 1,
    consumptionPolicy: "single-use",
    revokedBy: "user",
    revokedAt: 2,
    revokedReason: "Revoked",
    singleUseClaimedAt: 2,
    singleUseClaimId: "consumed",
  },
  toolExecutionReceipts: {
    receiptKey: "receipt-key",
    receiptId: "receipt",
    actionId: "action",
    projectId: "p",
    idempotencyKey: "action-key",
    actionFingerprint: "fingerprint",
    tool: "notes",
    operation: "create",
    status: "indeterminate",
    startedAt: 1,
    completedAt: 2,
    createdAt: 2,
  },
  memoryChangeSets: {
    changeSetId: "change",
    requestId: "request",
    projectKey: "p",
    baseRevision: 1,
    state: "rejected",
    records: [],
    rationale: "test",
    proposedBy: "agent",
    rejectedBy: "user",
    rejectedReason: "not approved",
    createdAt: 1,
    updatedAt: 2,
    rejectedAt: 2,
  },
  auditEvents: {
    requestId: "audit-request",
    scopeKey: "p",
    eventType: "omega.completion-assessment-recorded",
    actor: "agent",
    payload: { assessment: { residualUncertainty: 0.1, expiresAt: 100 } },
    createdAt: 1,
  },
  validationReports: {
    requestId: "request",
    scopeKey: "p",
    passed: false,
    checks: [],
    warnings: [],
    blockingFailures: ["blocked"],
    createdAt: 1,
  },
  externalReconciliations: {
    reconciliationId: "reconcile",
    executionKey: "execution",
    actionId: "action",
    requestId: "request",
    projectId: "p",
    idempotencyKey: "action-key",
    actionFingerprint: "fingerprint",
    effectFingerprint: "effect",
    tool: "notes",
    operation: "create",
    provider: "test",
    providerCorrelationId: "provider-correlation",
    state: "claimed",
    attemptCount: 2,
    nextAttemptAt: 1,
    leaseOwner: "worker",
    leaseToken: "lease",
    leaseExpiresAt: 2,
    createdAt: 1,
    updatedAt: 2,
  },
  omegaMissions: {
    missionId: "mission",
    projectKey: "p",
    objective: "Test",
    state: "validating",
    riskClass: "R0",
    autonomyClass: "A2",
    reversibilityClass: "REV-2",
    uncertaintyBudget: 0.2,
    acceptanceCriteria: [],
    policyVersion: "policy",
    createdAt: 1,
    updatedAt: 2,
  },
  omegaActionContracts: {
    missionId: "mission",
    contractId: "contract",
    toolActionId: "action",
    intent: "test",
    riskClass: "R0",
    reversibilityClass: "REV-2",
    requiredAuthority: "T1",
    scope: {},
    preconditions: [],
    status: "expired",
    authorityExpiresAt: 1,
    createdAt: 1,
    updatedAt: 2,
  },
  omegaEvidence: {
    missionId: "mission",
    evidenceId: "evidence",
    claim: "Observed",
    classification: "certain",
    sourceType: "primary-source",
    validUntil: 1,
    contradicts: [],
    createdAt: 1,
  },
  omegaValidationProofs: {
    missionId: "mission",
    proofId: "proof",
    criterionId: "criterion",
    method: "operational",
    result: "pass",
    independent: false,
    evidenceRefs: ["evidence"],
    performedBy: "test",
    performedAt: 1,
  },
  omegaContradictionResolutions: {
    missionId: "mission",
    resolutionId: "resolution",
    contradictionEvidenceId: "contradiction",
    contradictedEvidenceId: "evidence",
    reason: "resolved",
    resolvedBy: "user",
    authority: "approval-token",
    resolvedAt: 2,
  },
} satisfies { [K in S4Table]: Omit<Doc<K>, "_id" | "_creationTime" | "ownerId"> };

it("captures every S4 table including empty tables and rejects the wrong credential", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.query(anyApi.backupS4.capture, { serviceToken: "wrong", approvalToken }),
  ).rejects.toThrow(/unauthorized/i);
  const result = await t.query(anyApi.backupS4.capture, { serviceToken: token, approvalToken });
  expect(result.tableCounts.map((entry: { table: string }) => entry.table)).toEqual(S4_TABLES);
  expect(result.totalRows).toBe(0);
  expect(result.restoreVerified).toBe(false);
  expect(JSON.parse(result.payloadJson).tables).toHaveLength(17);
});

it("preserves all source fields and identities, excludes foreign owners in every table, and performs no writes", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (const table of S4_TABLES) {
      await ctx.db.insert(table, { ...fixtures[table], ownerId: "jarvis-cli" });
      await ctx.db.insert(table, { ...fixtures[table], ownerId: "foreign" });
    }
  });
  const snapshot = () =>
    t.run(async (ctx) => Promise.all(S4_TABLES.map((table) => ctx.db.query(table).collect())));
  const before = await snapshot();
  const result = await t.query(anyApi.backupS4.capture, { serviceToken: token, approvalToken });
  const payload = jsonToConvex(JSON.parse(result.payloadJson)) as {
    tables: { table: string; documents: Value[] }[];
  };
  expect(result.totalRows).toBe(17);
  for (const [index, entry] of payload.tables.entries())
    expect(entry.documents).toEqual(before[index]!.filter((row) => row.ownerId === "jarvis-cli"));
  expect(await snapshot()).toEqual(before);
  const receipt = payload.tables.find((entry) => entry.table === "toolExecutionReceipts")!
    .documents[0] as Record<string, Value>;
  expect(receipt.status).toBe("indeterminate");
  expect(receipt.requestId).toBeUndefined();
});

it("refuses table overflow rather than returning an incomplete capture", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 0; i < 1000; i++)
      await ctx.db.insert("auditEvents", { ...fixtures.auditEvents, ownerId: "jarvis-cli" });
  });
  expect(
    (await t.query(anyApi.backupS4.capture, { serviceToken: token, approvalToken })).totalRows,
  ).toBe(1000);
  await t.run((ctx) =>
    ctx.db.insert("auditEvents", { ...fixtures.auditEvents, ownerId: "jarvis-cli" }),
  );
  await expect(
    t.query(anyApi.backupS4.capture, { serviceToken: token, approvalToken }),
  ).rejects.toThrow(/bounded read limit/);
});

it("refuses payload byte overflow without truncation", async () => {
  const t = convexTest(schema, modules);
  await t.run((ctx) =>
    ctx.db.insert("notes", { ...fixtures.notes, ownerId: "jarvis-cli", body: "é".repeat(270000) }),
  );
  await expect(
    t.query(anyApi.backupS4.capture, { serviceToken: token, approvalToken }),
  ).rejects.toThrow(/byte limit/);
});

it("losslessly encodes optional future assessment metadata without granting restore authority", () => {
  const value = {
    mission: {
      completionAssessment: {
        version: "omega-completion-assessment:v1",
        assessmentId: "a",
        contextFingerprint: "source-physical-identities",
        residualUncertainty: 0.1,
        rationale: "Judgment",
        provenance: "owner-service",
        assessedAt: 1,
        expiresAt: 2,
      },
      completionAssessmentCount: 1,
    },
    special: [NaN, Infinity, -Infinity, -0, 2n, new Uint8Array([1, 2]).buffer],
  };
  const encoded = encodeS4Payload(value);
  expect(jsonToConvex(JSON.parse(encoded.payloadJson))).toEqual(value);
  expect(encodeS4Payload(value)).toEqual(encoded);
});

it("enforces the aggregate row boundary across owner-scoped tables", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 0; i < 1000; i++) {
      await ctx.db.insert("auditEvents", {
        ownerId: "jarvis-cli",
        scopeKey: "p",
        eventType: "x",
        actor: "agent",
        payload: {},
        createdAt: 1,
      });
      await ctx.db.insert("runtimeEvents", {
        ownerId: "jarvis-cli",
        eventId: String(i),
        sequence: i,
        eventType: "x",
        correlationId: "c",
        metadata: {},
        occurredAt: 1,
        createdAt: 1,
      });
    }
  });
  expect(
    (await t.query(anyApi.backupS4.capture, { serviceToken: token, approvalToken })).totalRows,
  ).toBe(2000);
  await t.run((ctx) =>
    ctx.db.insert("developmentSubjects", {
      ...fixtures.developmentSubjects,
      ownerId: "jarvis-cli",
    }),
  );
  await expect(
    t.query(anyApi.backupS4.capture, { serviceToken: token, approvalToken }),
  ).rejects.toThrow(/total row limit/);
});

it("rejects unsupported or lossy object shapes rather than silently dropping fields", () => {
  expect(() => encodeS4Payload(new Date() as unknown as Value)).toThrow(/losslessly/);
  expect(() => encodeS4Payload(Object.fromEntries([["__proto__", { preserve: true }]]))).toThrow(
    /losslessly/,
  );
});

it("denies sensitive export without independent operator approval", async () => {
  const t = convexTest(schema, modules);
  await t.run((ctx) =>
    ctx.db.insert("externalReconciliations", {
      ...fixtures.externalReconciliations,
      ownerId: "jarvis-cli",
    }),
  );
  await expect(t.query(anyApi.backupS4.capture, { serviceToken: token })).rejects.toThrow();
  await expect(
    t.query(anyApi.backupS4.capture, { serviceToken: token, approvalToken: "wrong" }),
  ).rejects.toThrow("Unauthorized");
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", token);
  await expect(
    t.query(anyApi.backupS4.capture, { serviceToken: token, approvalToken: token }),
  ).rejects.toThrow("must be distinct");
  expect(await t.run((ctx) => ctx.db.query("externalReconciliations").collect())).toHaveLength(1);
});
