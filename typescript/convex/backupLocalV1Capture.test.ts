import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { sha256HexBytes } from "../src/actions/sha256.js";
import type { LocalV1Client } from "../src/backup/v4/localV1Capture.js";
import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const serviceToken = "lv1-capture-service-token-000000000000";
const approvalToken = "lv1-capture-approval-token-00000000000";
const endpoint = "https://lv1-09-capture.invalid";
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const pdfDigest = `quote-pdf:v1:sha256:${sha256HexBytes(pdf)}`;

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", serviceToken);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", approvalToken);
  vi.stubEnv("CONVEX_URL", "https://live.example");
});
afterEach(() => vi.unstubAllEnvs());

async function seed() {
  const t = convexTest(schema, modules);
  const quote = await t.mutation(api.quotes.create, {
    serviceToken,
    clientId: "client-1",
    number: "LV1-0001",
    lineItems: [{ description: "Work", quantity: 1, unitPrice: 10 }],
    termsIncluded: true,
  });
  await t.run(async (ctx) => {
    const taskId = await ctx.db.insert("tasks", {
      ownerId: "jarvis-cli",
      title: "live-task",
      completed: false,
      category: "home",
      createdAt: 1,
    });
    await ctx.db.insert("reminders", {
      ownerId: "jarvis-cli",
      title: "live-reminder",
      createdAt: 2,
    });
    await ctx.db.insert("assistantState", {
      ownerId: "jarvis-cli",
      key: "primary",
      state: { note: "live-state" },
      updatedAt: 3,
    });
    const buildId = await ctx.db.insert("builds", {
      ownerId: "jarvis-cli",
      name: "live-build",
      kind: "boat",
      status: "active",
      createdAt: 4,
      updatedAt: 5,
    });
    await ctx.db.insert("buildLogs", {
      ownerId: "jarvis-cli",
      buildId,
      kind: "note",
      title: "live-log",
      createdAt: 6,
    });
    await ctx.db.insert("upgrades", {
      ownerId: "jarvis-cli",
      buildId,
      title: "live-upgrade",
      createdAt: 7,
    });
    await ctx.db.insert("assets", {
      ownerId: "jarvis-cli",
      name: "live-asset",
      kind: "tool",
      createdAt: 8,
      updatedAt: 9,
    });
    await ctx.db.insert("preferences", {
      ownerId: "jarvis-cli",
      key: "live-pref",
      value: "yes",
      createdAt: 10,
      updatedAt: 11,
    });
    const storageId = await ctx.storage.store(new Blob([pdf], { type: "application/pdf" }));
    await ctx.db.insert("quotePdfArtifacts", {
      ownerId: "jarvis-cli",
      quoteId: quote.aggregate.quoteId,
      revisionId: quote.revision.revisionId,
      revision: 1,
      revisionFingerprint: "quote-revision:v1:sha256:" + "a".repeat(64),
      storageId,
      digest: pdfDigest,
      byteLength: pdf.byteLength,
      mediaType: "application/pdf",
      filename: "lv1.pdf",
      rendererVersion: "quote-pdf:v1",
      generatedAt: "2026-10-07T03:00:00.000Z",
      issuer: { name: "Issuer" },
      client: { name: "Client" },
      createdAt: 12,
    });
    await ctx.db.insert("quoteDeliveryAttempts", {
      ownerId: "jarvis-cli",
      deliveryAttemptId: "delivery-1",
      quoteId: quote.aggregate.quoteId,
      revision: 1,
      revisionId: quote.revision.revisionId,
      revisionFingerprint: "fp",
      recipient: "ada@example.com",
      channel: "email",
      sendFingerprint: "send",
      idempotencyKey: "delivery-key",
      approvalId: "approval-1",
      actionFingerprint: "action",
      status: "succeeded",
      provider: "outlook",
      createdAt: 13,
      updatedAt: 14,
    });
    await ctx.db.insert("quoteMigrationRecords", {
      ownerId: "jarvis-cli",
      sourceKey: "legacy-1",
      status: "rejected",
      createdAt: 15,
    });
    await ctx.db.insert("toolActions", {
      ownerId: "jarvis-cli",
      actionId: "action-1",
      requestId: "request-1",
      projectKey: "project-1",
      baseRevision: 1,
      state: "approved",
      tool: "quotes",
      operation: "send",
      arguments: {},
      rationale: "send the quote",
      requiredAuthority: "T2",
      destructive: false,
      idempotencyKey: "action-key",
      proposedBy: "agent",
      createdAt: 16,
      updatedAt: 17,
    });
    await ctx.db.insert("toolExecutionReceipts", {
      ownerId: "jarvis-cli",
      receiptKey: "receipt-key",
      receiptId: "receipt-1",
      actionId: "action-1",
      projectId: "project-1",
      idempotencyKey: "receipt-idem",
      actionFingerprint: "action",
      tool: "quotes",
      operation: "send",
      status: "succeeded",
      startedAt: 18,
      completedAt: 19,
      createdAt: 20,
    });
    await ctx.db.insert("externalReconciliations", {
      ownerId: "jarvis-cli",
      reconciliationId: "recon-1",
      executionKey: "exec-1",
      actionId: "action-1",
      requestId: "request-1",
      projectId: "project-1",
      idempotencyKey: "recon-key",
      actionFingerprint: "action",
      effectFingerprint: "effect",
      tool: "quotes",
      operation: "send",
      provider: "outlook",
      providerCorrelationId: "corr-1",
      state: "resolved",
      attemptCount: 1,
      nextAttemptAt: 21,
      createdAt: 22,
      updatedAt: 23,
    });
    await ctx.db.insert("directCreateReceipts", {
      ownerId: "jarvis-cli",
      entityType: "task",
      entityId: taskId,
      idempotencyKey: "direct-key",
      requestFingerprint: "fp",
      createdAt: 24,
    });
    await ctx.db.insert("internalActionResults", {
      ownerId: "jarvis-cli",
      projectId: "project-1",
      actionFamilyId: "AM-004",
      idempotencyKey: "internal-key",
      actionFingerprint: "fp",
      entityType: "task",
      entityId: taskId,
      result: {
        kind: "task",
        id: taskId,
        projectId: "project-1",
        title: "live-task",
        category: "home",
        completed: false,
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
      },
      sourceRequestId: "request-1",
      correlationId: "corr-1",
      source: "test",
      createdAt: 25,
    });
  });
  return { t, quote };
}

it("captures every Convex Local V1 store, PDF bytes, and business JSON without writing live paths", async () => {
  const { t } = await seed();
  const { mkdtemp, mkdir, writeFile, readFile, readdir, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { captureLocalV1Archive } = await import("../src/backup/v4/localV1Capture.js");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-lv1-convex-"));
  const live = path.join(root, "live");
  await mkdir(live);
  const clientFile = path.join(live, "jarvis-clients.json");
  await writeFile(
    clientFile,
    `${JSON.stringify({
      version: 1,
      clients: [
        {
          id: "client-1",
          name: "Ada",
          contacts: [],
          notes: "notes",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })}\n`,
  );
  const before = createHash("sha256")
    .update(await readFile(clientFile))
    .digest("hex");
  let mutations = 0;
  const client = {
    query: t.query.bind(t),
    action: t.action.bind(t),
    mutation: async () => {
      mutations += 1;
      throw new Error("mutation");
    },
  } as unknown as LocalV1Client;
  try {
    const captured = await captureLocalV1Archive({
      outputDirectory: path.join(root, "out"),
      businessPaths: {
        clients: clientFile,
        properties: path.join(live, "jarvis-properties.json"),
        projects: path.join(live, "jarvis-projects.json"),
        quotes: path.join(live, "jarvis-quotes.json"),
        invoices: path.join(live, "jarvis-invoices.json"),
        enquiries: path.join(live, "jarvis-enquiries.json"),
        errands: path.join(live, "jarvis-errands.json"),
        businessSettings: path.join(live, "jarvis-business-settings.json"),
      },
      client,
      serviceToken,
      approvalToken,
      convexUrl: endpoint,
      capturedAt: new Date("2026-10-07T03:00:00.000Z"),
    });
    expect(mutations).toBe(0);
    expect(
      createHash("sha256")
        .update(await readFile(clientFile))
        .digest("hex"),
    ).toBe(before);
    expect(await readdir(live)).toEqual(["jarvis-clients.json"]);
    expect(captured.archive.manifest.completeness).toBe("partial");
    expect(captured.archive.groups.core?.tasks.map((task) => task.title)).toEqual(["live-task"]);
    expect(captured.archive.groups.core?.reminders.map((row) => row.title)).toEqual([
      "live-reminder",
    ]);
    expect(captured.archive.groups.core?.state).toEqual({ note: "live-state" });
    expect(captured.archive.groups.memory?.builds.map((row) => row.name)).toEqual(["live-build"]);
    expect(captured.archive.groups.memory?.buildLogs.map((row) => row.title)).toEqual(["live-log"]);
    expect(captured.archive.groups.memory?.upgrades.map((row) => row.title)).toEqual([
      "live-upgrade",
    ]);
    expect(captured.archive.groups.memory?.assets.map((row) => row.name)).toEqual(["live-asset"]);
    expect(captured.archive.groups.memory?.preferences.map((row) => row.key)).toEqual([
      "live-pref",
    ]);
    expect(captured.archive.groups.businessRecords?.clients.map((row) => row.id)).toEqual([
      "client-1",
    ]);
    const s6 = JSON.parse(
      (
        JSON.parse(
          await readFile(path.join(captured.outputDirectory, "convex-s6.json"), "utf8"),
        ) as {
          payloadJson: string;
        }
      ).payloadJson,
    ) as { tables: Array<{ table: string; documents: unknown[] }> };
    expect(s6.tables.map((table) => table.table)).toEqual([
      "quotes",
      "quoteRevisions",
      "quotePdfArtifacts",
      "quoteDeliveryAttempts",
      "quoteMigrationRecords",
      "toolActions",
      "toolExecutionReceipts",
      "externalReconciliations",
    ]);
    expect(s6.tables.every((table) => table.documents.length === 1)).toBe(true);
    const receipts = JSON.parse(
      (
        JSON.parse(
          await readFile(path.join(captured.outputDirectory, "convex-receipts.json"), "utf8"),
        ) as {
          payloadJson: string;
        }
      ).payloadJson,
    ) as { tables: Array<{ table: string; documents: Array<{ entityId: string }> }> };
    expect(receipts.tables.map((table) => table.table)).toEqual([
      "directCreateReceipts",
      "internalActionResults",
    ]);
    expect(receipts.tables.every((table) => table.documents.length === 1)).toBe(true);
    expect(captured.archive.manifest.blobs).toHaveLength(1);
    expect(captured.archive.manifest.blobs[0]?.digest).toBe(`sha256:${sha256HexBytes(pdf)}`);
    const blob = await readFile(path.join(captured.outputDirectory, "blobs", sha256HexBytes(pdf)));
    expect(Buffer.from(blob).equals(Buffer.from(pdf))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("aborts when PDF bytes are missing or a receipt table overflows", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([pdf], { type: "application/pdf" }));
    await ctx.storage.delete(storageId);
    await ctx.db.insert("quotePdfArtifacts", {
      ownerId: "jarvis-cli",
      quoteId: "quote-1",
      revisionId: "revision-1",
      revision: 1,
      revisionFingerprint: "fp",
      storageId,
      digest: pdfDigest,
      byteLength: pdf.byteLength,
      mediaType: "application/pdf",
      filename: "missing.pdf",
      rendererVersion: "quote-pdf:v1",
      generatedAt: "2026-10-07T03:00:00.000Z",
      issuer: { name: "Issuer" },
      client: { name: "Client" },
      createdAt: 1,
    });
  });
  const { anyApi } = await import("convex/server");
  const artifact = await t.run(async (ctx) => {
    const row = await ctx.db.query("quotePdfArtifacts").first();
    if (!row) throw new Error("missing artifact");
    return { id: row._id, storageId: row.storageId, byteLength: row.byteLength };
  });
  const listed = await t.query(anyApi.backupS6.captureLocalV1, {
    serviceToken,
    approvalToken,
    businessChecksum: `sha256:${"ab".repeat(32)}`,
    capturedAt: 1,
  });
  const listedTables = JSON.parse(listed.s6.payloadJson) as {
    tables: Array<{ table: string; documents: Array<{ _id: string }> }>;
  };
  expect(
    listedTables.tables.find((table) => table.table === "quotePdfArtifacts")?.documents[0]?._id,
  ).toBe(artifact.id);
  await expect(
    t.action(anyApi.backupS6.readLocalV1Blobs, {
      serviceToken,
      approvalToken,
      blobs: [
        {
          reference: `quotePdfArtifacts/${artifact.id}`,
          storageId: artifact.storageId,
          byteLength: artifact.byteLength,
        },
      ],
    }),
  ).rejects.toThrow(/PDF bytes are missing/);

  const overflow = convexTest(schema, modules);
  await overflow.run(async (ctx) => {
    for (let index = 0; index < 101; index += 1) {
      await ctx.db.insert("directCreateReceipts", {
        ownerId: "jarvis-cli",
        entityType: "task",
        entityId: `task-${index}`,
        idempotencyKey: `key-${index}`,
        requestFingerprint: "fp",
        createdAt: index,
      });
    }
  });
  await expect(
    overflow.query(anyApi.backupS6.captureLocalV1, {
      serviceToken,
      approvalToken,
      businessChecksum: `sha256:${"cd".repeat(32)}`,
      capturedAt: 1,
    }),
  ).rejects.toThrow(/limit/);
});
