import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

import { externalExecutionScopeKey } from "../src/reconciliation/externalReconciliation.js";
import { sha256HexBytes } from "../src/actions/sha256.js";
import {
  fingerprintToolAction,
  fingerprintToolEffect,
  ToolExecutionService,
} from "../src/actions/toolExecution.js";
import type { ToolAction } from "../src/actions/toolActions.js";
import { readS6MutableQuotes } from "../src/backup/v4/s6MutableQuotes.js";
import { assertRecoverable } from "../src/backup/archiveManifest.js";
import { ConvexExternalReconciliationStore } from "../src/persistence/convexExternalReconciliations.js";
import { ConvexPersistence } from "../src/persistence/convexPersistence.js";
import { ConvexToolExecutionReceiptStore } from "../src/persistence/convexToolExecutionReceipts.js";
import { ConvexAssetStore } from "../src/assets/convexAssetStore.js";
import { ConvexBuildStore } from "../src/builds/convexBuildStore.js";
import { JsonClientStore } from "../src/clients/jsonClientStore.js";
import { JsonInvoiceStore } from "../src/invoices/jsonInvoiceStore.js";
import { JsonQuoteStore } from "../src/quotes/jsonQuoteStore.js";
import { ConvexQuoteRepository } from "../src/quotes/convexQuoteRepository.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { readLocalV1Blobs } from "./backupS6.js";
import { restoreLocalV1 } from "./backupLocalV1Restore.js";
import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const serviceToken = "lv1-restore-service-token-000000000000";
const approvalToken = "lv1-restore-approval-token-00000000000";
const endpoint = "https://lv1-09-restore.invalid";
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const pdfDigest = `quote-pdf:v1:sha256:${sha256HexBytes(pdf)}`;
const now = 10_000;
const idempotencyKey = "send-key";

const sendAction: ToolAction = {
  actionId: "action-1",
  requestId: "request-1",
  projectId: "project-1",
  baseRevision: 1,
  state: "approved",
  tool: "quotes",
  operation: "send",
  arguments: { quoteId: "bound-in-seed" },
  rationale: "send the quote",
  requiredAuthority: "T2",
  destructive: false,
  idempotencyKey,
  proposedBy: "agent",
  approvalExpiryPolicy: "ttl",
  approvalExpiresAt: new Date(1).toISOString(),
  isApprovalExpired: false,
  createdAt: new Date(16).toISOString(),
  updatedAt: new Date(17).toISOString(),
};

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", serviceToken);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", approvalToken);
  vi.stubEnv("CONVEX_URL", "https://live.example");
});
afterEach(() => vi.unstubAllEnvs());

it("keeps Local V1 restore off the public Convex API", () => {
  const registered = restoreLocalV1 as {
    isAction?: boolean;
    isInternal?: boolean;
    isPublic?: boolean;
  };
  const readable = readLocalV1Blobs as { isPublic?: boolean };
  expect(registered.isAction).toBe(true);
  expect(registered.isInternal).toBe(true);
  expect(registered.isPublic).not.toBe(true);
  expect(readable.isPublic).toBe(true);
  expect(() => {
    if (registered.isPublic !== true) {
      throw new Error("Could not find public function for 'backupLocalV1Restore:restoreLocalV1'.");
    }
  }).toThrow(/Could not find public function/);
});

function clientFor(t: ReturnType<typeof convexTest>): ConvexClientLike {
  return {
    query: t.query.bind(t) as ConvexClientLike["query"],
    mutation: t.mutation.bind(t) as ConvexClientLike["mutation"],
  };
}

function receiptKey(): string {
  return `external:${externalExecutionScopeKey({
    projectId: sendAction.projectId,
    tool: sendAction.tool,
    operation: sendAction.operation,
    idempotencyKey,
  })}`;
}

async function seed(expiresAt = 1) {
  const t = convexTest(schema, modules);
  const quote = await t.mutation(api.quotes.create, {
    serviceToken,
    clientId: "client-1",
    number: "LV1-0001",
    lineItems: [{ description: "Work", quantity: 1, unitPrice: 10 }],
    termsIncluded: true,
  });
  const action = { ...sendAction, arguments: { quoteId: quote.aggregate.quoteId } };
  const actionFingerprint = fingerprintToolAction(action);
  const effectFingerprint = fingerprintToolEffect(action);
  const key = receiptKey();
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
    const revision = await ctx.db
      .query("quoteRevisions")
      .withIndex("by_owner_and_revision_id", (q) =>
        q.eq("ownerId", "jarvis-cli").eq("revisionId", quote.revision.revisionId),
      )
      .unique();
    const aggregate = await ctx.db
      .query("quotes")
      .withIndex("by_owner_and_quote_id", (q) =>
        q.eq("ownerId", "jarvis-cli").eq("quoteId", quote.aggregate.quoteId),
      )
      .unique();
    if (!revision || !aggregate) throw new Error("seed quote missing");
    const { _id: _revisionId, _creationTime: _revisionTime, ...revisionFields } = revision;
    await ctx.db.insert("quoteRevisions", {
      ...revisionFields,
      revisionId: "revision-final",
      revision: 2,
      revisionVersion: 2,
      status: "finalized",
      fingerprint: `quote-revision:v1:sha256:${"ab".repeat(64)}`,
      predecessorRevisionId: revision.revisionId,
      finalizedAt: 40,
      updatedAt: 40,
    });
    await ctx.db.patch("quotes", aggregate._id, {
      currentRevision: 2,
      currentRevisionId: "revision-final",
      aggregateVersion: 2,
      updatedAt: 40,
    });
    const storageId = await ctx.storage.store(new Blob([pdf], { type: "application/pdf" }));
    await ctx.db.insert("quotePdfArtifacts", {
      ownerId: "jarvis-cli",
      quoteId: quote.aggregate.quoteId,
      revisionId: "revision-final",
      revision: 2,
      revisionFingerprint: `quote-revision:v1:sha256:${"ab".repeat(64)}`,
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
      revision: 2,
      revisionId: "revision-final",
      revisionFingerprint: "fp",
      recipient: "ada@example.com",
      channel: "email",
      sendFingerprint: "send",
      idempotencyKey,
      approvalId: "approval-1",
      actionFingerprint,
      status: "succeeded",
      provider: "outlook",
      reconciliationId: "recon-1",
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
      actionId: action.actionId,
      requestId: action.requestId,
      projectKey: action.projectId,
      baseRevision: action.baseRevision,
      state: "approved",
      tool: action.tool,
      operation: action.operation,
      arguments: action.arguments,
      rationale: action.rationale,
      requiredAuthority: action.requiredAuthority,
      destructive: action.destructive,
      idempotencyKey,
      proposedBy: "agent",
      approvedBy: "user",
      approvedAt: 1,
      approvalExpiryPolicy: "ttl",
      approvalExpiresAt: expiresAt,
      createdAt: 16,
      updatedAt: 17,
    });
    await ctx.db.insert("toolExecutionReceipts", {
      ownerId: "jarvis-cli",
      receiptKey: key,
      receiptId: "receipt-1",
      actionId: action.actionId,
      requestId: action.requestId,
      projectId: action.projectId,
      idempotencyKey,
      actionFingerprint,
      effectFingerprint,
      tool: action.tool,
      operation: action.operation,
      actor: "agent",
      status: "succeeded",
      provider: "outlook",
      reconciliationId: "recon-1",
      startedAt: 18,
      completedAt: 19,
      createdAt: 20,
    });
    await ctx.db.insert("externalReconciliations", {
      ownerId: "jarvis-cli",
      reconciliationId: "recon-1",
      executionKey: key,
      actionId: action.actionId,
      requestId: action.requestId,
      projectId: action.projectId,
      idempotencyKey,
      actionFingerprint,
      effectFingerprint,
      tool: action.tool,
      operation: action.operation,
      provider: "outlook",
      providerCorrelationId: "corr-1",
      receiptKey: key,
      receiptId: "receipt-1",
      state: "resolved",
      terminalStatus: "succeeded",
      attemptCount: 1,
      nextAttemptAt: 21,
      createdAt: 22,
      updatedAt: 23,
      resolvedAt: 23,
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
  return { t, quote, action, actionFingerprint, effectFingerprint };
}

function businessFiles(live: string): {
  clients: string;
  properties: string;
  projects: string;
  quotes: string;
  invoices: string;
  enquiries: string;
  errands: string;
  businessSettings: string;
} {
  const path = live;
  return {
    clients: `${path}/jarvis-clients.json`,
    properties: `${path}/jarvis-properties.json`,
    projects: `${path}/jarvis-projects.json`,
    quotes: `${path}/jarvis-quotes.json`,
    invoices: `${path}/jarvis-invoices.json`,
    enquiries: `${path}/jarvis-enquiries.json`,
    errands: `${path}/jarvis-errands.json`,
    businessSettings: `${path}/jarvis-business-settings.json`,
  };
}

async function writeBusiness(live: string, quoteId: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await writeFile(
    join(live, "jarvis-clients.json"),
    `${JSON.stringify({
      version: 1,
      clients: [
        { id: "client-1", name: "Ada", contacts: [], notes: "notes", createdAt: 1, updatedAt: 1 },
      ],
    })}\n`,
  );
  await writeFile(
    join(live, "jarvis-quotes.json"),
    `${JSON.stringify({
      version: 1,
      quotes: [
        {
          id: "flat-quote-1",
          clientId: "client-1",
          number: "FLAT-1",
          status: "draft",
          lineItems: [{ description: "Flat", quantity: 1, unitPrice: 5 }],
          subtotal: 5,
          tax: 0,
          total: 5,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    })}\n`,
  );
  await writeFile(
    join(live, "jarvis-invoices.json"),
    `${JSON.stringify({
      version: 1,
      invoices: [
        {
          id: "invoice-1",
          clientId: "client-1",
          quoteId,
          number: "INV-1",
          status: "issued",
          lineItems: [{ description: "Stage", quantity: 1, unitPrice: 10 }],
          subtotal: 10,
          taxRate: 0.1,
          tax: 1,
          total: 11,
          amountPaid: 0,
          balanceDue: 11,
          paymentStatus: "unpaid",
          payments: [],
          createdAt: 3,
          updatedAt: 3,
        },
      ],
    })}\n`,
  );
}

it("restores a partial capture into scratch JSON and an empty convex-test, then rereads", async () => {
  const seeded = await seed();
  const { mkdtemp, mkdir, readFile, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { captureLocalV1Archive } = await import("../src/backup/v4/localV1Capture.js");
  const { restoreLocalV1Archive } = await import("../src/backup/v4/localV1Restore.js");
  const { z } = await import("zod");
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-lv1-restore-"));
  const live = path.join(root, "live");
  const capturedDir = path.join(root, "capture");
  const restoredDir = path.join(root, "restored");
  await mkdir(live);
  await writeBusiness(live, seeded.quote.aggregate.quoteId);
  const source = {
    query: seeded.t.query.bind(seeded.t),
    action: seeded.t.action.bind(seeded.t),
    mutation: async () => {
      throw new Error("capture mutation");
    },
  };
  try {
    await captureLocalV1Archive({
      outputDirectory: capturedDir,
      businessPaths: businessFiles(live),
      client: source as never,
      serviceToken,
      approvalToken,
      convexUrl: endpoint,
      capturedAt: new Date(now),
    });
    const sidecar = JSON.parse(
      await readFile(path.join(capturedDir, "convex-s6.json"), "utf8"),
    ) as {
      payloadJson: string;
      payloadSha256: string;
    };
    const archive = JSON.parse(await readFile(path.join(capturedDir, "archive.json"), "utf8")) as {
      groups: {
        businessRecords: import("../src/backup/v4/businessSource.js").BusinessRecordsPayload;
      };
      manifest: import("../src/backup/archiveManifest.js").ArchiveManifest;
    };
    expect(() => assertRecoverable(archive.manifest)).toThrow();
    expect(() => readS6MutableQuotes(sidecar, archive.groups.businessRecords)).toThrow(
      /Unsupported nonempty S6 dependency|Unsupported mutable quote state/,
    );

    const target = convexTest(schema, modules);
    const restored = await restoreLocalV1Archive({
      captureDirectory: capturedDir,
      jsonDirectory: restoredDir,
      client: { action: target.action.bind(target) } as never,
      serviceToken,
      approvalToken,
      convexUrl: endpoint,
      now,
      liveDataDir: live,
    });
    expect(restored.archive.manifest.completeness).toBe("partial");
    expect(restored.maps.tasks).toHaveLength(1);
    expect(restored.maps.builds).toHaveLength(1);
    expect(restored.maps.tasks[0]?.sourceId).not.toBe(restored.maps.tasks[0]?.targetId);
    expect(restored.maps.builds[0]?.sourceId).not.toBe(restored.maps.builds[0]?.targetId);

    const clients = await new JsonClientStore(
      path.join(restoredDir, "jarvis-clients.json"),
      () => {},
    ).list();
    const flatQuotes = await new JsonQuoteStore(
      path.join(restoredDir, "jarvis-quotes.json"),
      () => {},
    ).list();
    const invoices = await new JsonInvoiceStore(
      path.join(restoredDir, "jarvis-invoices.json"),
      () => {},
    ).list();
    expect(clients.map((row) => row.id)).toEqual(["client-1"]);
    expect(flatQuotes.map((row) => row.id)).toEqual(["flat-quote-1"]);
    expect(invoices.map((row) => row.quoteId)).toEqual([seeded.quote.aggregate.quoteId]);

    const client = clientFor(target);
    const snapshot = await new ConvexPersistence(client, serviceToken).snapshot();
    expect(snapshot.tasks.map((row) => row.title)).toEqual(["live-task"]);
    expect(snapshot.tasks[0]?.id).toBe(restored.maps.tasks[0]?.targetId);
    expect(snapshot.reminders.map((row) => row.title)).toEqual(["live-reminder"]);
    expect(restored.maps.reminders).toHaveLength(1);
    expect(snapshot.reminders[0]?.id).toBe(restored.maps.reminders[0]?.targetId);
    expect(restored.maps.reminders[0]?.sourceId).not.toBe(restored.maps.reminders[0]?.targetId);
    expect(snapshot.state).toEqual({ note: "live-state" });
    expect(
      (await new ConvexBuildStore(client, serviceToken).list()).map((row) => row.name),
    ).toEqual(["live-build"]);
    expect(
      (await new ConvexAssetStore(client, serviceToken).list()).map((row) => row.name),
    ).toEqual(["live-asset"]);
    const repository = new ConvexQuoteRepository(client, serviceToken);
    const reread = await repository.getQuote(seeded.quote.aggregate.quoteId);
    expect(reread?.revision.status).toBe("finalized");
    expect(reread?.revision.revisionId).toBe("revision-final");
    expect(reread?.revision.fingerprint).toBe(`quote-revision:v1:sha256:${"ab".repeat(64)}`);
    expect((await repository.listQuotes({})).map((row) => row.quoteId)).toEqual([
      seeded.quote.aggregate.quoteId,
    ]);

    const linked = await target.run(async (ctx) => {
      const log = await ctx.db.query("buildLogs").first();
      const upgrade = await ctx.db.query("upgrades").first();
      const direct = await ctx.db.query("directCreateReceipts").first();
      const internal = await ctx.db.query("internalActionResults").first();
      const actionRow = await ctx.db.query("toolActions").first();
      const artifact = await ctx.db.query("quotePdfArtifacts").first();
      const historical = await ctx.db
        .query("quoteRevisions")
        .withIndex("by_owner_quote_and_revision", (q) =>
          q
            .eq("ownerId", "jarvis-cli")
            .eq("quoteId", seeded.quote.aggregate.quoteId)
            .eq("revision", 1),
        )
        .unique();
      const stored = artifact ? await ctx.storage.get(artifact.storageId) : null;
      return {
        logBuildId: log?.buildId,
        upgradeBuildId: upgrade?.buildId,
        directEntityId: direct?.entityId,
        internalEntityId: internal?.entityId,
        internalResultId: internal && "id" in internal.result ? internal.result.id : undefined,
        expiresAt: actionRow?.approvalExpiresAt,
        state: actionRow?.state,
        digest: artifact?.digest,
        bytes: stored ? Array.from(new Uint8Array(await stored.arrayBuffer())) : null,
        historicalStatus: historical?.status,
      };
    });
    expect(linked.logBuildId).toBe(restored.maps.builds[0]?.targetId);
    expect(linked.upgradeBuildId).toBe(restored.maps.builds[0]?.targetId);
    expect(linked.directEntityId).toBe(restored.maps.tasks[0]?.targetId);
    expect(linked.internalEntityId).toBe(restored.maps.tasks[0]?.targetId);
    expect(linked.internalResultId).toBe(restored.maps.tasks[0]?.targetId);
    expect(linked.expiresAt).toBe(1);
    expect(linked.state).toBe("approved");
    expect(linked.digest).toBe(pdfDigest);
    expect(linked.bytes).toEqual(Array.from(pdf));
    expect(linked.historicalStatus).toBe("draft");

    let sent = 0;
    const executor = new ToolExecutionService(
      [
        {
          tool: "quotes",
          operation: "send",
          externalProvider: "outlook",
          schema: z.object({ quoteId: z.string() }) as unknown as ZodType<Record<string, unknown>>,
          execute: () => {
            sent += 1;
            return Promise.reject(new Error("mail was sent"));
          },
        },
      ],
      new ConvexToolExecutionReceiptStore(client, serviceToken),
      new ConvexExternalReconciliationStore(client, serviceToken),
    );
    const replayed = await executor.execute({
      action: { ...seeded.action, isApprovalExpired: false },
      authority: "T2",
      idempotencyKey,
    });
    expect(sent).toBe(0);
    expect(replayed.receiptId).toBe("receipt-1");
    expect(replayed.status).toBe("succeeded");

    await expect(
      target.mutation(api.toolActions.approve, {
        serviceToken,
        approvalToken,
        projectKey: "project-1",
        actionId: "action-1",
        expectedRevision: 1,
      }),
    ).rejects.toThrow();
    const afterApprove = await target.run(async (ctx) => ctx.db.query("toolActions").first());
    expect(afterApprove?.approvalExpiresAt).toBe(1);
    expect(afterApprove?.state).toBe("approved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fails closed on a missing PDF, a live target, an executable approval, and a nonempty database", async () => {
  const seeded = await seed();
  const { mkdtemp, mkdir, readFile, rm, writeFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { captureLocalV1Archive } = await import("../src/backup/v4/localV1Capture.js");
  const { restoreLocalV1Archive } = await import("../src/backup/v4/localV1Restore.js");
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-lv1-restore-fail-"));
  const live = path.join(root, "live");
  const capturedDir = path.join(root, "capture");
  await mkdir(live);
  await writeBusiness(live, seeded.quote.aggregate.quoteId);
  try {
    await captureLocalV1Archive({
      outputDirectory: capturedDir,
      businessPaths: businessFiles(live),
      client: {
        query: seeded.t.query.bind(seeded.t),
        action: seeded.t.action.bind(seeded.t),
        mutation: async () => {
          throw new Error("capture mutation");
        },
      } as never,
      serviceToken,
      approvalToken,
      convexUrl: endpoint,
      capturedAt: new Date(now),
    });
    const target = convexTest(schema, modules);
    const client = { action: target.action.bind(target) };
    const blobName = sha256HexBytes(pdf);
    await rm(path.join(capturedDir, "blobs", blobName));
    const missingDir = path.join(root, "missing");
    await expect(
      restoreLocalV1Archive({
        captureDirectory: capturedDir,
        jsonDirectory: missingDir,
        client,
        serviceToken,
        approvalToken,
        convexUrl: endpoint,
        now,
        liveDataDir: live,
      }),
    ).rejects.toThrow(/PDF bytes are missing/);
    await expect(readdir(missingDir)).rejects.toThrow();

    await writeFile(path.join(capturedDir, "blobs", blobName), Buffer.from([0]));
    await expect(
      restoreLocalV1Archive({
        captureDirectory: capturedDir,
        jsonDirectory: path.join(root, "bad-digest"),
        client,
        serviceToken,
        approvalToken,
        convexUrl: endpoint,
        now,
        liveDataDir: live,
      }),
    ).rejects.toThrow(/digest/);
    await expect(readdir(path.join(root, "bad-digest"))).rejects.toThrow();
    await writeFile(path.join(capturedDir, "blobs", blobName), pdf);

    await expect(
      restoreLocalV1Archive({
        captureDirectory: capturedDir,
        jsonDirectory: path.join(live, "out"),
        client,
        serviceToken,
        approvalToken,
        convexUrl: endpoint,
        now,
        liveDataDir: live,
      }),
    ).rejects.toThrow(/overlaps live data/);
    await expect(readdir(path.join(live, "out"))).rejects.toThrow();

    await expect(
      restoreLocalV1Archive({
        captureDirectory: capturedDir,
        jsonDirectory: path.join(root, "live-url"),
        client,
        serviceToken,
        approvalToken,
        convexUrl: "https://live.example",
        now,
        liveDataDir: live,
      }),
    ).rejects.toThrow(/CONVEX_URL/);

    const sidecarPath = path.join(capturedDir, "convex-s6.json");
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as {
      payloadJson: string;
      payloadSha256: string;
      restoreVerified: false;
    };
    const payload = JSON.parse(sidecar.payloadJson) as {
      tables: Array<{ table: string; documents: Array<{ approvalExpiresAt?: number }> }>;
    };
    const actions = payload.tables.find((table) => table.table === "toolActions");
    if (!actions?.documents[0]) throw new Error("missing tool action");
    actions.documents[0].approvalExpiresAt = now + 1;
    const { sha256Hex } = await import("../src/actions/sha256.js");
    const payloadJson = JSON.stringify(payload);
    await writeFile(
      sidecarPath,
      `${JSON.stringify({ ...sidecar, payloadJson, payloadSha256: sha256Hex(payloadJson) })}\n`,
    );
    const executableDir = path.join(root, "executable");
    await expect(
      restoreLocalV1Archive({
        captureDirectory: capturedDir,
        jsonDirectory: executableDir,
        client,
        serviceToken,
        approvalToken,
        convexUrl: endpoint,
        now,
        liveDataDir: live,
      }),
    ).rejects.toThrow(/executable/);
    await expect(readdir(executableDir)).rejects.toThrow();

    const occupied = convexTest(schema, modules);
    await occupied.run(async (ctx) => {
      await ctx.db.insert("tasks", {
        ownerId: "jarvis-cli",
        title: "already",
        completed: false,
        category: "home",
        createdAt: 1,
      });
    });
    actions.documents[0].approvalExpiresAt = 1;
    const restoredPayload = JSON.stringify(payload);
    await writeFile(
      sidecarPath,
      `${JSON.stringify({
        ...sidecar,
        payloadJson: restoredPayload,
        payloadSha256: sha256Hex(restoredPayload),
      })}\n`,
    );
    await expect(
      restoreLocalV1Archive({
        captureDirectory: capturedDir,
        jsonDirectory: path.join(root, "occupied"),
        client: { action: occupied.action.bind(occupied) },
        serviceToken,
        approvalToken,
        convexUrl: endpoint,
        now,
        liveDataDir: live,
      }),
    ).rejects.toThrow(/empty database/);
    await expect(readdir(path.join(root, "occupied"))).rejects.toThrow();
    expect(
      await occupied.run(async (ctx) =>
        (await ctx.db.query("tasks").collect()).map((row) => row.title),
      ),
    ).toEqual(["already"]);

    const { symlink } = await import("node:fs/promises");
    const alias = path.join(root, "capture-alias");
    await symlink(capturedDir, alias);
    await expect(
      restoreLocalV1Archive({
        captureDirectory: capturedDir,
        jsonDirectory: path.join(alias, "restored"),
        client,
        serviceToken,
        approvalToken,
        convexUrl: endpoint,
        now,
        liveDataDir: live,
      }),
    ).rejects.toThrow(/overlaps live data/);
    await expect(readdir(path.join(capturedDir, "restored"))).rejects.toThrow();

    const deliveries = payload.tables.find((table) => table.table === "quoteDeliveryAttempts") as
      { documents: Array<{ status?: string }> } | undefined;
    if (!deliveries?.documents[0]) throw new Error("missing delivery");
    const deliveryRuntimeToken = "lv1-restore-delivery-token-000000000000";
    vi.stubEnv("JARVIS_DELIVERY_RUNTIME_TOKEN", deliveryRuntimeToken);
    for (const status of ["pending", "executing", "indeterminate"] as const) {
      deliveries.documents[0].status = status;
      const nonTerminal = JSON.stringify(payload);
      await writeFile(
        sidecarPath,
        `${JSON.stringify({
          ...sidecar,
          payloadJson: nonTerminal,
          payloadSha256: sha256Hex(nonTerminal),
        })}\n`,
      );
      const blocked = convexTest(schema, modules);
      const blockedDir = path.join(root, `delivery-${status}`);
      await expect(
        restoreLocalV1Archive({
          captureDirectory: capturedDir,
          jsonDirectory: blockedDir,
          client: { action: blocked.action.bind(blocked) },
          serviceToken,
          approvalToken,
          convexUrl: endpoint,
          now,
          liveDataDir: live,
        }),
      ).rejects.toThrow(/not terminal/);
      await expect(readdir(blockedDir)).rejects.toThrow();
      expect(
        await blocked.run(async (ctx) => ctx.db.query("quoteDeliveryAttempts").collect()),
      ).toEqual([]);
      if (status === "pending") {
        await expect(
          blocked.mutation(api.quoteDeliveries.markExecuting, {
            serviceToken,
            deliveryRuntimeToken,
            deliveryAttemptId: "delivery-1",
            expectedStatus: "pending",
          }),
        ).rejects.toThrow(/not found/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
