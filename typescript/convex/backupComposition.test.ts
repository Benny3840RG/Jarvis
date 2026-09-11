import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { groupChecksum } from "../src/backup/archiveManifest.js";
import { encodeS4Payload } from "../src/backup/v4/convexCapture.js";
import { restoreS4ProjectNotes } from "./backupS4Restore.js";
import { restoreS6MutableQuotes } from "./backupS6Restore.js";
import type { BusinessRecordsPayload } from "../src/backup/v4/businessSource.js";
const serviceToken = "joint-service-token-local-0000000000000000";
const approvalToken = "joint-approval-token-local-000000000000000";
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
async function sourceFixture() {
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

  // Consume a source-only physical identity so the restored action receives a different ID.
  await source.run(async (ctx) => {
    const project = (await ctx.db.query("projects").collect())[0]!;
    const { _id, _creationTime, ...fields } = project;
    const dummy = await ctx.db.insert("projects", { ...fields, projectKey: "discarded" });
    await ctx.db.delete("projects", dummy);
  });
  await source.mutation(anyApi.toolActions.stage, proposal);
  await source.mutation(anyApi.toolActions.reject, {
    serviceToken,
    projectKey: "p",
    actionId: "action",
    reason: "No",
  });
  await source.mutation(anyApi.notes.create, {
    serviceToken,
    projectId: "p",
    title: "Note",
    body: "Opaque",
    tags: [],
    domain: "workshop",
    sensitivity: "private",
    retention: "standard",
    idempotencyKey: "note",
    actionFingerprint: "note-hash",
    sourceRequestId: "note-request",
    correlationId: "note-correlation",
    source: "test",
  });
  await source.mutation(anyApi.memoryChangeSets.stage, {
    serviceToken,
    projectKey: "p",
    changeSetId: "change",
    requestId: "memory-request",
    expectedRevision: 3,
    records: [
      {
        kind: "fact",
        recordId: "fact",
        statement: "Observed",
        source: "user",
        confidence: 1,
        recordedAt: "2026-09-11T00:00:00.000Z",
      },
    ],
    rationale: "Memory",
    proposedBy: "agent",
  });
  await source.mutation(anyApi.memoryChangeSets.reject, {
    serviceToken,
    projectKey: "p",
    changeSetId: "change",
    reason: "No",
  });
  await source.mutation(anyApi.quotes.create, {
    serviceToken,
    clientId: "client",
    projectId: "p",
    number: "KEEP-0042",
    lineItems: [{ description: "Work", quantity: 2, unitPrice: 50 }],
    termsIncluded: true,
  });
  return source;
}

const capture = (source: ReturnType<typeof convexTest>) =>
  source.query(anyApi.backupS4.captureJoint, {
    serviceToken,
    approvalToken,
    businessChecksum: groupChecksum(business),
  });
it("reproduces standalone composition barriers", async () => {
  const source = await sourceFixture();
  const s4 = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  const s6 = await source.query(anyApi.backupS6.capture, {
    serviceToken,
    approvalToken,
    businessChecksum: groupChecksum(business),
  });
  const target = convexTest(schema, modules);
  await target.run((ctx) => restoreS4ProjectNotes(ctx, { ...s4, serviceToken, approvalToken }));
  await expect(
    target.run((ctx) =>
      restoreS6MutableQuotes(ctx, { ...s6, serviceToken, approvalToken, business }),
    ),
  ).rejects.toThrow(/Unsupported/);
  await expect(
    target.run((ctx) => restoreS4ProjectNotes(ctx, { ...s4, serviceToken, approvalToken })),
  ).rejects.toThrow(/empty/);
});
it("captures shared tables once and restores both closed graphs with ordinary business/domain proofs", async () => {
  const source = await sourceFixture();
  const material = await capture(source);
  const s4 = JSON.parse(material.s4.payloadJson),
    s6 = JSON.parse(material.s6.payloadJson);
  expect(s4.capturedAt).toBe(s6.capturedAt);
  expect(s4.tables.find((x: { table: string }) => x.table === "toolActions")).toEqual(
    s6.tables.find((x: { table: string }) => x.table === "toolActions"),
  );
  const { restoreS4S6 } = await import("./backupComposition.js");
  const target = convexTest(schema, modules);
  const identities = await target.run((ctx) =>
    restoreS4S6(ctx, { ...material, serviceToken, approvalToken, business }),
  );
  expect(identities.s4.toolActions[0]!.targetId).not.toBe(identities.s4.toolActions[0]!.sourceId);
  expect(identities.s6.quotes[0]!.targetId).not.toBe(identities.s6.quotes[0]!.sourceId);
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { coreDataFiles, businessDataFiles } =
    await import("../src/persistence/jarvisDataPaths.js");
  const { captureJsonGroups } = await import("../src/backup/v4/jsonSource.js");
  const { buildArchiveV4 } = await import("../src/backup/v4/archive.js");
  const { restoreArchiveV4 } = await import("../src/backup/v4/restore.js");
  const root = await mkdtemp(path.join(tmpdir(), "joint-proof-"));
  try {
    const paths = Object.fromEntries(
      Object.entries({ ...coreDataFiles, ...businessDataFiles }).map(([key, file]) => [
        key,
        path.join(root, path.basename(file)),
      ]),
    ) as typeof coreDataFiles & typeof businessDataFiles;
    await writeFile(paths.clients, JSON.stringify({ version: 1, clients: business.clients }));
    await writeFile(paths.projects, JSON.stringify({ version: 1, projects: business.projects }));
    const archive = buildArchiveV4(await captureJsonGroups(paths), new Date());
    const destination = path.join(root, "target");
    await restoreArchiveV4(archive, destination, {
      allowPartial: true,
      liveDataDir: path.join(root, "live"),
    });
    const { verifyRestoredS4S6 } = await import("../src/backup/v4/verifyComposition.js");
    const proofInput = {
      capture: material,
      archive,
      destination,
      identities,
      client: {
        query:
          target.query as import("../src/persistence/convexPersistence.js").ConvexClientLike["query"],
        mutation: async () => {
          throw new Error("Read-only proof");
        },
      },
      serviceToken,
      approvalToken,
    };
    const proof = await verifyRestoredS4S6(proofInput);
    expect(proof.s4.sourceChecksum).toBe(proof.s4.restoredChecksum);
    expect(proof.s6.sourceChecksum).toBe(proof.s6.restoredChecksum);
    expect(proof.verifiedGroups).toEqual([]);
    await expect(
      target.run((ctx) => restoreS4S6(ctx, { ...material, serviceToken, approvalToken, business })),
    ).rejects.toThrow(/empty/);
    const badMap = structuredClone(identities);
    badMap.s6.quotes[0]!.sourceCreationTime += 1;
    await expect(verifyRestoredS4S6({ ...proofInput, identities: badMap })).rejects.toThrow(/map/);
    await writeFile(
      path.join(destination, "jarvis-clients.json"),
      JSON.stringify({ version: 1, clients: [{ ...business.clients[0], name: "Changed" }] }),
    );
    await expect(verifyRestoredS4S6(proofInput)).rejects.toThrow();
    await writeFile(
      path.join(destination, "jarvis-clients.json"),
      JSON.stringify({ version: 1, clients: business.clients }),
    );
    await target.run((ctx) =>
      ctx.db.patch("notes", identities.s4.notes[0]!.targetId, { body: "Changed" }),
    );
    await expect(verifyRestoredS4S6(proofInput)).rejects.toThrow(/checksum/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([
  "physical-id",
  "quote-physical-id",
  "shared-id",
  "capture-clock",
  "business-project",
  "shared-missing",
  "shared-content",
  "bad-s6",
  "bad-s4",
  "business",
  "source-owner",
  "approval",
  "service",
])("prevalidates %s before any insertion", async (variant) => {
  const material = await capture(await sourceFixture());
  const s4 = JSON.parse(material.s4.payloadJson),
    s6 = JSON.parse(material.s6.payloadJson);
  if (variant === "physical-id")
    s4.tables.find((x: { table: string }) => x.table === "projects").documents[0]._id =
      "not-a-physical-id";
  if (variant === "quote-physical-id")
    s6.tables.find((x: { table: string }) => x.table === "quotes").documents[0]._id =
      "bad-quote-id";
  if (variant === "shared-id")
    s6.tables.find((x: { table: string }) => x.table === "toolActions").documents[0]._id =
      "changed-id";
  if (variant === "capture-clock") s6.capturedAt += 1;
  if (variant === "business-project")
    s6.businessChecksum = groupChecksum({ ...business, projects: [] });
  if (variant === "shared-missing")
    s6.tables.find((x: { table: string }) => x.table === "toolActions").documents = [];
  if (variant === "shared-content")
    s6.tables.find((x: { table: string }) => x.table === "toolActions").documents[0].rationale =
      "Changed";
  if (variant === "bad-s6")
    s6.tables.find((x: { table: string }) => x.table === "quoteRevisions").documents[0].total = 999;
  if (variant === "bad-s4")
    s4.tables.find((x: { table: string }) => x.table === "toolActions").documents[0].approvedBy =
      "user";
  if (variant === "source-owner") s6.ownerId = "foreign";
  const { restoreS4S6 } = await import("./backupComposition.js");
  const target = convexTest(schema, modules);
  let inserted = 0;
  await expect(
    target.run((ctx) =>
      restoreS4S6(
        {
          ...ctx,
          db: {
            ...ctx.db,
            insert: async () => {
              inserted++;
              throw new Error("Unexpected insertion");
            },
          },
        },
        {
          s4: encodeS4Payload(s4),
          s6: encodeS4Payload(s6),
          business:
            variant === "business"
              ? { ...business, clients: [] }
              : variant === "business-project"
                ? { ...business, projects: [] }
                : business,
          serviceToken: variant === "service" ? "wrong" : serviceToken,
          approvalToken: variant === "approval" ? "wrong" : approvalToken,
        },
      ),
    ),
  ).rejects.toThrow();
  expect(inserted).toBe(0);
});
it("rolls back S4 rows when a later S6 insertion fails and refuses foreign target rows", async () => {
  const material = await capture(await sourceFixture());
  const { restoreS4S6 } = await import("./backupComposition.js");
  const target = convexTest(schema, modules);
  let inserted = 0;
  await expect(
    target.run((ctx) =>
      restoreS4S6(
        {
          ...ctx,
          db: {
            ...ctx.db,
            insert: async (table, value) => {
              if (table === "quotes") throw new Error("Injected late failure");
              inserted++;
              return ctx.db.insert(table, value);
            },
          },
        },
        { ...material, business, serviceToken, approvalToken },
      ),
    ),
  ).rejects.toThrow(/Injected/);
  expect(inserted).toBeGreaterThan(0);
  await target.run(async (ctx) => {
    for (const table of Object.keys(
      schema.tables,
    ) as import("./_generated/dataModel.js").TableNames[])
      expect(await ctx.db.query(table).collect()).toEqual([]);
  });
  await target.run((ctx) =>
    ctx.db.insert("quoteMigrationRecords", {
      ownerId: "foreign",
      sourceKey: "foreign",
      status: "rejected",
      createdAt: 1,
    }),
  );
  await expect(
    target.run((ctx) => restoreS4S6(ctx, { ...material, business, serviceToken, approvalToken })),
  ).rejects.toThrow(/empty/);
});

it("joint capture keeps the smaller shared-table cap and authenticates both credentials", async () => {
  const source = await sourceFixture();
  await expect(
    source.query(anyApi.backupS4.captureJoint, {
      serviceToken,
      approvalToken: serviceToken,
      businessChecksum: groupChecksum(business),
    }),
  ).rejects.toThrow();
  await source.run(async (ctx) => {
    const { _id, _creationTime, ...fields } = (await ctx.db.query("toolActions").collect())[0]!;
    for (let i = 0; i < 100; i++)
      await ctx.db.insert("toolActions", {
        ...fields,
        actionId: `extra-${i}`,
        idempotencyKey: `extra-${i}`,
      });
  });
  expect(
    (await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken })).tableCounts.find(
      (row: { table: string }) => row.table === "toolActions",
    ).rowCount,
  ).toBe(101);
  await expect(capture(source)).rejects.toThrow(/limit/);
});

it("the union reader reads each owner table exactly once", async () => {
  const source = await sourceFixture();
  const { readBackupTables } = await import("./backupCaptureTables.js");
  const { S4_TABLES } = await import("../src/backup/v4/convexCapture.js");
  const { S6_TABLES } = await import("../src/backup/v4/s6MutableQuotes.js");
  const tables = [
    ...S4_TABLES,
    ...S6_TABLES.filter((table) => !S4_TABLES.some((value) => value === table)),
  ];
  const calls: string[] = [];
  await source.run((ctx) =>
    readBackupTables(
      {
        db: {
          ...ctx.db,
          query: (table) => {
            calls.push(table);
            return ctx.db.query(table);
          },
        },
      },
      "jarvis-cli",
      tables,
      (table) => (S6_TABLES.some((value) => value === table) ? 100 : 1000),
    ),
  );
  expect(calls).toEqual(tables);
  expect(new Set(calls).size).toBe(22);
});
