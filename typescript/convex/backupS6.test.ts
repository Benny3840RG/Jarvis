import { anyApi, getFunctionName } from "convex/server";
import { jsonToConvex, type Value } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { api } from "./_generated/api.js";
import { encodeS4Payload } from "../src/backup/v4/convexCapture.js";
import { groupChecksum } from "../src/backup/archiveManifest.js";
import type { BusinessRecordsPayload } from "../src/backup/v4/businessSource.js";

const serviceToken = "s6-local-test-service-token-00000000000000";
const approvalToken = "s6-local-test-approval-token-0000000000000";
const business: BusinessRecordsPayload = {
  clients: [{ id: "client", name: "Client", contacts: [], createdAt: 1, updatedAt: 1 }],
  projects: [],
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
async function fixture() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const id = await ctx.db.insert("quoteMigrationRecords", {
      ownerId: "scratch",
      sourceKey: "scratch",
      status: "rejected",
      createdAt: 1,
    });
    await ctx.db.delete("quoteMigrationRecords", id);
  });
  const quote = await t.mutation(api.quotes.create, {
    serviceToken,
    clientId: "client",
    number: "KEEP-0042",
    lineItems: [{ description: "Work", quantity: 2, unitPrice: 50 }],
    taxRate: 0.1,
    termsIncluded: true,
  });
  return { t, quote };
}
async function capture(t: ReturnType<typeof convexTest>) {
  return t.query(anyApi.backupS6.capture, {
    serviceToken,
    approvalToken,
    businessChecksum: groupChecksum(business),
  });
}
it("captures the actual owner aggregate with its current draft and preserves quote number on typed restore", async () => {
  const { t, quote } = await fixture();
  const material = await capture(t);
  expect(material.restoreVerified).toBe(false);
  const target = convexTest(schema, modules);
  const { restoreS6MutableQuotes } = await import("./backupS6Restore.js");
  const mapping = await target.run((ctx) =>
    restoreS6MutableQuotes(ctx, { ...material, serviceToken, approvalToken, business }),
  );
  expect(mapping.quotes[0]?.targetId).not.toBe(quote.aggregate._id);
  const restored = await target.query(api.quotes.get, {
    serviceToken,
    quoteId: quote.aggregate.quoteId,
  });
  expect(restored?.aggregate.number).toBe("KEEP-0042");
  expect(restored?.revision.total).toBe(110);
  expect(restored?.revision.status).toBe("draft");
  expect(await target.run((ctx) => ctx.db.query("quoteDeliveryAttempts").collect())).toEqual([]);
});
it("requires independent capture approval", async () => {
  const { t } = await fixture();
  await expect(
    t.query(anyApi.backupS6.capture, {
      serviceToken,
      approvalToken: serviceToken,
      businessChecksum: groupChecksum(business),
    }),
  ).rejects.toThrow();
});
for (const [name, alter] of Object.entries({
  "finalized state": (row: Record<string, Value>) => {
    row.status = "finalized";
  },
  "prior revision edge": (row: Record<string, Value>) => {
    row.predecessorRevisionId = "missing";
  },
  "migration origin": (row: Record<string, Value>) => {
    row.source = "legacy-migration";
  },
  "corrupt monetary total": (row: Record<string, Value>) => {
    row.total = 1;
  },
  "nonfinite clock": (row: Record<string, Value>) => {
    row.updatedAt = NaN;
  },
  "unexpected field": (row: Record<string, Value>) => {
    row.hidden = "must not disappear";
  },
}))
  it(`refuses ${name} before any restore insert`, async () => {
    const { t } = await fixture();
    const material = await capture(t);
    const decoded = jsonToConvex(JSON.parse(material.payloadJson)) as {
      tables: Array<{ table: string; documents: Array<Record<string, Value>> }>;
    };
    alter(decoded.tables.find((row) => row.table === "quoteRevisions")!.documents[0]!);
    const corrupt = encodeS4Payload(decoded);
    const target = convexTest(schema, modules);
    const { restoreS6MutableQuotes } = await import("./backupS6Restore.js");
    await expect(
      target.run((ctx) =>
        restoreS6MutableQuotes(ctx, { ...corrupt, serviceToken, approvalToken, business }),
      ),
    ).rejects.toThrow();
    expect(await target.run((ctx) => ctx.db.query("quotes").collect())).toEqual([]);
  });
it("refuses unresolved client and project references, and substituted business payload", async () => {
  const { t, quote } = await fixture();
  const material = await capture(t);
  const { restoreS6MutableQuotes } = await import("./backupS6Restore.js");
  const target = convexTest(schema, modules);
  await expect(
    target.run((ctx) =>
      restoreS6MutableQuotes(ctx, {
        ...material,
        serviceToken,
        approvalToken,
        business: { ...business, clients: [] },
      }),
    ),
  ).rejects.toThrow();
  await t.run((ctx) => ctx.db.patch("quotes", quote.aggregate._id, { projectId: "missing" }));
  const missing = await capture(t);
  await expect(
    target.run((ctx) =>
      restoreS6MutableQuotes(ctx, { ...missing, serviceToken, approvalToken, business }),
    ),
  ).rejects.toThrow();
});
it("refuses occupied isolated target including a foreign owner's row", async () => {
  const { t } = await fixture();
  const material = await capture(t);
  const target = convexTest(schema, modules);
  await target.run((ctx) =>
    ctx.db.insert("quoteMigrationRecords", {
      ownerId: "foreign",
      sourceKey: "old",
      status: "rejected",
      createdAt: 1,
    }),
  );
  const { restoreS6MutableQuotes } = await import("./backupS6Restore.js");
  await expect(
    target.run((ctx) =>
      restoreS6MutableQuotes(ctx, { ...material, serviceToken, approvalToken, business }),
    ),
  ).rejects.toThrow(/empty/);
});
it("refuses nonempty migration history rather than silently dropping it", async () => {
  const { t, quote } = await fixture();
  await t.run((ctx) =>
    ctx.db.insert("quoteMigrationRecords", {
      ownerId: quote.aggregate.ownerId,
      sourceKey: "old",
      status: "rejected",
      createdAt: 1,
    }),
  );
  const material = await capture(t);
  const target = convexTest(schema, modules);
  const { restoreS6MutableQuotes } = await import("./backupS6Restore.js");
  await expect(
    target.run((ctx) =>
      restoreS6MutableQuotes(ctx, { ...material, serviceToken, approvalToken, business }),
    ),
  ).rejects.toThrow(/Unsupported/);
});

it("proves actual normal quote and business reads and refuses a changed restored client", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { coreDataFiles, businessDataFiles } =
    await import("../src/persistence/jarvisDataPaths.js");
  const { captureJsonGroups } = await import("../src/backup/v4/jsonSource.js");
  const { buildArchiveV4 } = await import("../src/backup/v4/archive.js");
  const { restoreArchiveV4 } = await import("../src/backup/v4/restore.js");
  const { prepareS6MutableRestore, verifyRestoredS6MutableQuotes } =
    await import("../src/backup/v4/verifyS6MutableQuotes.js");
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-s6-proof-"));
  try {
    const paths = Object.fromEntries(
      Object.entries({ ...coreDataFiles, ...businessDataFiles }).map(([key, file]) => [
        key,
        path.join(root, path.basename(file)),
      ]),
    ) as typeof coreDataFiles & typeof businessDataFiles;
    await writeFile(paths.clients, JSON.stringify({ version: 1, clients: business.clients }));
    const jsonCapture = await captureJsonGroups(paths);
    const archive = buildArchiveV4(jsonCapture, new Date());
    const dest = path.join(root, "target");
    await restoreArchiveV4(archive, dest, {
      allowPartial: true,
      liveDataDir: path.join(root, "live"),
    });
    const { t } = await fixture();
    await t.mutation(api.quotes.create, {
      serviceToken,
      clientId: "client",
      number: "KEEP-0043",
      lineItems: [{ description: "Different", quantity: 1, unitPrice: 30 }],
      termsIncluded: false,
    });
    const material = await capture(t);
    const prepared = await prepareS6MutableRestore(material, archive, dest);
    const target = convexTest(schema, modules);
    const { restoreS6MutableQuotes } = await import("./backupS6Restore.js");
    const identities = await target.run((ctx) =>
      restoreS6MutableQuotes(ctx, {
        ...material,
        serviceToken,
        approvalToken,
        business: prepared.business,
      }),
    );
    const client: import("../src/persistence/convexPersistence.js").ConvexClientLike = {
      query:
        target.query as import("../src/persistence/convexPersistence.js").ConvexClientLike["query"],
      mutation: async () => {
        throw new Error("Read-only verification cannot mutate.");
      },
    };
    const proof = await verifyRestoredS6MutableQuotes({
      capture: material,
      archive,
      destination: dest,
      identities,
      client,
      serviceToken,
      approvalToken,
    });
    expect(proof.completeness).toBe("partial");
    expect(proof.verifiedGroups).toEqual([]);
    expect(proof.sourceChecksum).toBe(proof.restoredChecksum);
    expect(proof.normalQuoteReads).toBe(2);
    for (const corruption of ["duplicate", "amount"] as const) {
      const malformed: typeof client = {
        ...client,
        query: (async (
          ref: import("convex/server").FunctionReference<"query">,
          args?: Record<string, unknown>,
        ) => {
          const value = await client.query(ref, args ?? {});
          if (getFunctionName(ref) !== "quotes:list") return value;
          const rows = structuredClone(value) as Array<{ revision: { total: number } }>;
          if (corruption === "duplicate") return [rows[0], rows[0]];
          rows[0]!.revision.total = 12345;
          return rows;
        }) as typeof client.query,
      };
      await expect(
        verifyRestoredS6MutableQuotes({
          capture: material,
          archive,
          destination: dest,
          identities,
          client: malformed,
          serviceToken,
          approvalToken,
        }),
      ).rejects.toThrow(/list/);
    }
    const orphanProject = {
      id: "orphan-project",
      clientId: "missing-client",
      title: "Orphan",
      status: "lead" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const orphanBusiness = { ...business, projects: [orphanProject] };
    const orphanArchive = buildArchiveV4(
      { ...jsonCapture, businessRecords: orphanBusiness },
      new Date(),
    );
    await writeFile(
      path.join(dest, "jarvis-projects.json"),
      JSON.stringify({ version: 1, projects: [orphanProject] }),
    );
    const orphanMaterial = await t.query(anyApi.backupS6.capture, {
      serviceToken,
      approvalToken,
      businessChecksum: groupChecksum(orphanBusiness),
    });
    await expect(prepareS6MutableRestore(orphanMaterial, orphanArchive, dest)).rejects.toThrow(
      /reference/,
    );
    await writeFile(
      path.join(dest, "jarvis-projects.json"),
      JSON.stringify({ version: 1, projects: [] }),
    );
    await writeFile(
      path.join(dest, "jarvis-clients.json"),
      JSON.stringify({ version: 1, clients: [{ ...business.clients[0], name: "Changed" }] }),
    );
    await expect(
      verifyRestoredS6MutableQuotes({
        capture: material,
        archive,
        destination: dest,
        identities,
        client,
        serviceToken,
        approvalToken,
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves a real reviewed first revision without finalization or new numbering", async () => {
  const { t, quote } = await fixture();
  await t.mutation(api.quotes.submitForReview, {
    serviceToken,
    quoteId: quote.aggregate.quoteId,
    revision: 1,
    expectedAggregateVersion: 1,
    expectedRevisionVersion: 1,
  });
  const material = await capture(t);
  const target = convexTest(schema, modules);
  const { restoreS6MutableQuotes } = await import("./backupS6Restore.js");
  await target.run((ctx) =>
    restoreS6MutableQuotes(ctx, { ...material, serviceToken, approvalToken, business }),
  );
  const snapshot = await target.query(api.quotes.get, {
    serviceToken,
    quoteId: quote.aggregate.quoteId,
  });
  expect(snapshot?.revision.status).toBe("reviewed");
  expect(snapshot?.aggregate.aggregateVersion).toBe(2);
  expect(snapshot?.aggregate.number).toBe("KEEP-0042");
  expect(snapshot?.revision.fingerprint).toBeUndefined();
});
it("owner scopes capture and refuses a mismatched restore owner", async () => {
  const { t, quote } = await fixture();
  await t.run((ctx) =>
    ctx.db.insert("quoteMigrationRecords", {
      ownerId: "foreign",
      sourceKey: "foreign",
      status: "rejected",
      createdAt: 1,
    }),
  );
  const material = await capture(t);
  const decoded = jsonToConvex(JSON.parse(material.payloadJson)) as {
    ownerId: string;
    tables: Array<{ table: string; documents: Array<Record<string, Value>> }>;
  };
  expect(decoded.tables.find((row) => row.table === "quoteMigrationRecords")?.documents).toEqual(
    [],
  );
  decoded.ownerId = "foreign";
  for (const table of decoded.tables) for (const row of table.documents) row.ownerId = "foreign";
  const changed = encodeS4Payload(decoded);
  const target = convexTest(schema, modules);
  const { restoreS6MutableQuotes } = await import("./backupS6Restore.js");
  await expect(
    target.run((ctx) =>
      restoreS6MutableQuotes(ctx, { ...changed, serviceToken, approvalToken, business }),
    ),
  ).rejects.toThrow(/owner/);
  expect(quote.aggregate.ownerId).not.toBe("foreign");
});
it("refuses over-limit tables and payload bytes rather than truncating", async () => {
  const { t, quote } = await fixture();
  await t.run(async (ctx) => {
    for (let i = 0; i < 101; i++)
      await ctx.db.insert("quoteMigrationRecords", {
        ownerId: quote.aggregate.ownerId,
        sourceKey: String(i),
        status: "rejected",
        createdAt: 1,
      });
  });
  await expect(capture(t)).rejects.toThrow(/limit/);
  const { t: large, quote: largeQuote } = await fixture();
  await large.run((ctx) =>
    ctx.db.patch("quoteRevisions", largeQuote.revision._id, { notes: "x".repeat(513 * 1024) }),
  );
  await expect(capture(large)).rejects.toThrow(/byte limit/);
});
for (const table of [
  "quotePdfArtifacts",
  "quoteDeliveryAttempts",
  "toolActions",
  "toolExecutionReceipts",
  "externalReconciliations",
] as const)
  it(`refuses unsupported ${table} history`, async () => {
    const { t } = await fixture();
    const material = await capture(t);
    const decoded = jsonToConvex(JSON.parse(material.payloadJson)) as {
      tables: Array<{ table: string; documents: Array<Record<string, Value>> }>;
    };
    decoded.tables.find((row) => row.table === table)!.documents.push({ opaque: "unsupported" });
    const changed = encodeS4Payload(decoded);
    const target = convexTest(schema, modules);
    const { restoreS6MutableQuotes } = await import("./backupS6Restore.js");
    await expect(
      target.run((ctx) =>
        restoreS6MutableQuotes(ctx, { ...changed, serviceToken, approvalToken, business }),
      ),
    ).rejects.toThrow(/Unsupported/);
  });
