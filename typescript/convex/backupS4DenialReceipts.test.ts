import { anyApi } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { groupChecksum } from "../src/backup/archiveManifest.js";
import { encodeS4Payload } from "../src/backup/v4/convexCapture.js";
import { verifyRestoredS4ProjectNotes } from "../src/backup/v4/restore.js";
import { readS6MutableQuotes } from "../src/backup/v4/s6MutableQuotes.js";
import { createNoteToolDefinition } from "../src/actions/createNoteTool.js";
import { ToolExecutionService } from "../src/actions/toolExecution.js";
import type { BusinessRecordsPayload } from "../src/backup/v4/businessSource.js";
import { ConvexToolActionService } from "../src/persistence/convexToolActions.js";
import { ConvexToolExecutionReceiptStore } from "../src/persistence/convexToolExecutionReceipts.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { restoreS4S6 } from "./backupComposition.js";
import { restoreS4ProjectNotes } from "./backupS4Restore.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const serviceToken = "denial-receipt-service-token-000000000000";
const approvalToken = "denial-receipt-approval-token-00000000000";
const business: BusinessRecordsPayload = {
  clients: [{ id: "client", name: "Client", contacts: [], createdAt: 1, updatedAt: 1 }],
  projects: [
    {
      id: "p",
      clientId: "client",
      title: "Distinct JSON project",
      status: "lead",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  properties: [],
  quotes: [],
  invoices: [],
  enquiries: [],
  errands: [],
  businessSettings: null,
};

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", serviceToken);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", approvalToken);
});
afterEach(() => vi.unstubAllEnvs());

const proposal = {
  serviceToken,
  actionId: "action",
  requestId: "request",
  projectKey: "p",
  expectedRevision: 3,
  tool: "notes",
  operation: "create",
  arguments: { title: "Title", body: "Opaque body", domain: "workshop", sensitivity: "internal" },
  rationale: "Record note",
  requiredAuthority: "T1" as const,
  destructive: false,
  idempotencyKey: "proposal",
  proposedBy: "agent" as const,
};

function clientFor(t: ReturnType<typeof convexTest>): ConvexClientLike {
  return { query: t.query.bind(t), mutation: t.mutation.bind(t) } as ConvexClientLike;
}

function documents(
  payload: { tables: Array<{ table: string; documents: unknown[] }> },
  table: string,
) {
  const entry = payload.tables.find((candidate) => candidate.table === table);
  if (!entry) throw new Error(`Missing ${table}`);
  return entry.documents as Array<Record<string, unknown>>;
}

async function sourceWithDenials() {
  const source = convexTest(schema, modules);
  await source.mutation(anyApi.projects.upsert, {
    serviceToken,
    projectKey: "p",
    projectName: "Project",
    projectType: "test",
    status: "active",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    revision: 3,
    domains: ["workshop"],
    summary: "",
    preferences: {
      outputStyle: "brief",
      communicationTone: "plain",
      detailLevel: "normal",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
  await source.run(async (ctx) => {
    const project = (await ctx.db.query("projects").collect())[0]!;
    const { _id, _creationTime, ...fields } = project;
    const discarded = await ctx.db.insert("projects", { ...fields, projectKey: "discarded" });
    await ctx.db.delete("projects", discarded);
  });
  await source.mutation(anyApi.toolActions.stage, proposal);
  await source.mutation(anyApi.toolActions.reject, {
    serviceToken,
    projectKey: "p",
    actionId: "action",
    reason: "No",
  });
  const action = await new ConvexToolActionService(clientFor(source), serviceToken).get({
    projectId: "p",
    actionId: "action",
  });
  if (!action) throw new Error("Rejected action missing.");
  const create = vi.fn(async () => {
    throw new Error("Tool must not execute");
  });
  const executor = new ToolExecutionService(
    [createNoteToolDefinition({ create } as never)],
    new ConvexToolExecutionReceiptStore(clientFor(source), serviceToken),
  );
  await executor.execute({ action, authority: "T1", idempotencyKey: "denial-a" });
  await executor.execute({ action, authority: "T1", idempotencyKey: "denial-b" });
  expect(create).not.toHaveBeenCalled();
  const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  return { source, capture, action };
}

async function expectRefusal(payload: Value, pattern: RegExp) {
  const target = convexTest(schema, modules);
  let insertions = 0;
  await expect(
    target.run((ctx) =>
      restoreS4ProjectNotes(
        {
          ...ctx,
          db: {
            ...ctx.db,
            insert: async () => {
              insertions += 1;
              throw new Error("Unexpected insertion");
            },
          },
        },
        { ...encodeS4Payload(payload), serviceToken, approvalToken },
      ),
    ),
  ).rejects.toThrow(pattern);
  expect(insertions).toBe(0);
}

it("restores closed denial receipts without installing replay or approval authority", async () => {
  const { capture, action } = await sourceWithDenials();
  const payload = JSON.parse(capture.payloadJson);
  const sourceReceipts = documents(payload, "toolExecutionReceipts");
  expect(sourceReceipts).toHaveLength(2);
  const target = convexTest(schema, modules);
  const ids = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken }),
  );
  const proof = await verifyRestoredS4ProjectNotes(
    capture,
    ids,
    clientFor(target),
    serviceToken,
    approvalToken,
  );
  expect(proof.completeness).toBe("partial");
  expect(proof.verifiedGroups).toEqual([]);
  expect(ids.toolExecutionReceipts).toHaveLength(2);
  for (const mapping of ids.toolExecutionReceipts) {
    expect(mapping.targetId).not.toBe(mapping.sourceId);
  }
  const restored = await target.run((ctx) => ctx.db.query("toolExecutionReceipts").collect());
  expect(restored.map((row) => row.receiptKey).sort()).toEqual(
    sourceReceipts.map((row) => row.receiptKey).sort(),
  );
  expect(restored.map((row) => row.receiptId).sort()).toEqual(
    sourceReceipts.map((row) => row.receiptId).sort(),
  );
  const store = new ConvexToolExecutionReceiptStore(clientFor(target), serviceToken);
  const original = sourceReceipts.find((row) => row.idempotencyKey === "denial-a");
  if (!original) throw new Error("Source denial receipt missing.");
  const read = await store.get(String(original.receiptKey));
  expect(read).toMatchObject({
    receiptId: original.receiptId,
    actionId: "action",
    status: "blocked",
    errorCode: "not-authorized",
    actionFingerprint: original.actionFingerprint,
  });
  expect(await target.run((ctx) => ctx.db.query("externalReconciliations").collect())).toEqual([]);
  expect(await target.run((ctx) => ctx.db.query("omegaMissions").collect())).toEqual([]);
  await expect(
    target.mutation(anyApi.toolActions.approve, {
      serviceToken,
      approvalToken,
      projectKey: "p",
      actionId: "action",
      expectedRevision: 3,
    }),
  ).rejects.toThrow(/rejected/i);
  const create = vi.fn(async () => {
    throw new Error("Tool must not execute");
  });
  const executor = new ToolExecutionService(
    [createNoteToolDefinition({ create } as never)],
    new ConvexToolExecutionReceiptStore(clientFor(target), serviceToken),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = await executor.execute({ action, authority: "T1", idempotencyKey: "denial-a" });
  expect(create).not.toHaveBeenCalled();
  expect(again.status).toBe("blocked");
  expect(again.errorCode).toBe("not-authorized");
  expect(again.completedAt).not.toBe(read?.completedAt);
  const after = await target.run((ctx) => ctx.db.query("toolExecutionReceipts").collect());
  expect(after).toHaveLength(3);
  expect(after.find((row) => row.receiptKey === original.receiptKey)).toMatchObject({
    status: "blocked",
    errorCode: "not-authorized",
    completedAt: original.completedAt,
    actionFingerprint: original.actionFingerprint,
  });
});

it.each([
  "succeeded",
  "other-error",
  "approval",
  "reconciliation",
  "effect",
  "safety",
  "output",
  "provider",
  "policy",
  "source",
  "correlation",
  "primary-key",
  "fingerprint",
  "orphan",
  "clock",
  "duplicate",
] as const)("refuses denial receipt case %s before insertion", async (variant) => {
  const { capture } = await sourceWithDenials();
  const payload = JSON.parse(capture.payloadJson);
  const receipts = documents(payload, "toolExecutionReceipts");
  const row = receipts[0]!;
  if (variant === "succeeded") row.status = "succeeded";
  if (variant === "other-error") row.errorCode = "failed";
  if (variant === "approval") row.approvalId = "approval";
  if (variant === "reconciliation") row.reconciliationId = "recon";
  if (variant === "effect") row.effectFingerprint = "effect";
  if (variant === "safety") row.safetyBinding = { version: 1 };
  if (variant === "output") row.outputDigest = "digest";
  if (variant === "provider") row.provider = "mail";
  if (variant === "policy") row.policyVersion = "other-policy";
  if (variant === "source") row.source = "other-source";
  if (variant === "correlation") row.correlationId = "other-request";
  if (variant === "primary-key")
    row.receiptKey = `${String(row.projectId)}:${String(row.actionId)}:${String(row.idempotencyKey)}`;
  if (variant === "fingerprint") row.actionFingerprint = "not-the-producer-fingerprint";
  if (variant === "orphan") row.actionId = "missing";
  if (variant === "clock") row.startedAt = Number(row.completedAt) + 1000;
  if (variant === "duplicate") {
    const last = receipts[receipts.length - 1]!;
    receipts.push({
      ...row,
      _id: "toolExecutionReceipts;duplicate",
      _creationTime: Number(last._creationTime) + 1,
    });
  }
  await expectRefusal(
    payload,
    variant === "duplicate" ? /Duplicate denial receipt key/ : /Unsupported denial receipt/,
  );
});

it("refuses a scalar constraint value before insertion", async () => {
  const source = convexTest(schema, modules);
  await source.mutation(anyApi.projects.upsert, {
    serviceToken,
    projectKey: "p",
    projectName: "Project",
    projectType: "test",
    status: "active",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    revision: 1,
    domains: ["workshop"],
    summary: "",
    preferences: {
      outputStyle: "brief",
      communicationTone: "plain",
      detailLevel: "normal",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
  await source.mutation(anyApi.projectRecords.upsert, {
    serviceToken,
    projectKey: "p",
    record: {
      kind: "constraint",
      recordId: "budget",
      type: "budget",
      value: "AUD 10",
      hardConstraint: true,
    },
  });
  const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  await expectRefusal(
    JSON.parse(capture.payloadJson) as Value,
    /Unsupported or inconsistent project memory record reference/,
  );
});

it("refuses a reconciliation row beside an otherwise closed denial receipt", async () => {
  const { source, capture } = await sourceWithDenials();
  await source.run(async (ctx) => {
    const project = (await ctx.db.query("projects").collect())[0]!;
    await ctx.db.insert("externalReconciliations", {
      ownerId: project.ownerId,
      reconciliationId: "reconcile",
      executionKey: "execution",
      actionId: "action",
      requestId: "request",
      projectId: "p",
      idempotencyKey: "denial-a",
      actionFingerprint: "fingerprint",
      effectFingerprint: "effect",
      tool: "notes",
      operation: "create",
      provider: "test",
      providerCorrelationId: "provider-correlation",
      state: "claimed",
      attemptCount: 1,
      nextAttemptAt: 1,
      leaseOwner: "worker",
      leaseToken: "lease",
      leaseExpiresAt: 2,
      createdAt: 1,
      updatedAt: 2,
    });
  });
  const withLease = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  expect(withLease.payloadSha256).not.toBe(capture.payloadSha256);
  await expectRefusal(
    JSON.parse(withLease.payloadJson) as Value,
    /Unsupported nonempty S4 table: externalReconciliations/,
  );
});

it("restores the same denial receipts through the joint adapter when S6 matches", async () => {
  const { source } = await sourceWithDenials();
  await source.mutation(anyApi.quotes.create, {
    serviceToken,
    clientId: "client",
    projectId: "p",
    number: "KEEP-0042",
    lineItems: [{ description: "Work", quantity: 2, unitPrice: 50 }],
    termsIncluded: true,
  });
  const material = await source.query(anyApi.backupS4.captureJoint, {
    serviceToken,
    approvalToken,
    businessChecksum: groupChecksum(business),
  });
  const target = convexTest(schema, modules);
  const identities = await target.run((ctx) =>
    restoreS4S6(ctx, { ...material, serviceToken, approvalToken, business }),
  );
  expect(identities.s4.toolExecutionReceipts).toHaveLength(2);
  expect(identities.s4.toolExecutionReceipts[0]!.targetId).not.toBe(
    identities.s4.toolExecutionReceipts[0]!.sourceId,
  );
  const recaptured = await target.query(anyApi.backupS4.captureJoint, {
    serviceToken,
    approvalToken,
    businessChecksum: groupChecksum(business),
  });
  const reread = readS6MutableQuotes(recaptured.s6, business, recaptured.s4);
  expect(reread.ownerId).toBe("jarvis-cli");
  const fresh = convexTest(schema, modules);
  const mismatched = JSON.parse(material.s6.payloadJson);
  const shared = documents(mismatched, "toolExecutionReceipts");
  shared[0]!.status = "succeeded";
  await expect(
    fresh.run((ctx) =>
      restoreS4S6(ctx, {
        s4: material.s4,
        s6: encodeS4Payload(mismatched),
        business,
        serviceToken,
        approvalToken,
      }),
    ),
  ).rejects.toThrow(/shared receipt inventory mismatch/);
  expect(await fresh.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
});
