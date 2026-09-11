import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { restoreS4ProjectNotes } from "./backupS4Restore.js";
import { verifyRestoredS4ProjectNotes } from "../src/backup/v4/restore.js";
import { encodeS4Payload } from "../src/backup/v4/convexCapture.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
const serviceToken = "memory-restore-service-token-00000000000",
  approvalToken = "memory-restore-approval-token-0000000000";
beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", serviceToken);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", approvalToken);
});
afterEach(() => vi.unstubAllEnvs());
const records = [
  {
    kind: "fact" as const,
    recordId: "fact",
    statement: "Observed",
    source: "user" as const,
    confidence: 1,
    recordedAt: "2026-09-11T00:00:00.000Z",
  },
  {
    kind: "assumption" as const,
    recordId: "assumption",
    statement: "Assumed",
    status: "unverified" as const,
    impact: "low" as const,
  },
  {
    kind: "measurement" as const,
    recordId: "measurement",
    name: "Width",
    value: 42,
    unit: "mm",
    source: "tool",
  },
  {
    kind: "decision" as const,
    recordId: "decision",
    decision: "Use it",
    rationale: "Measured",
    alternativesRejected: [],
    timestamp: "2026-09-11T00:00:00.000Z",
  },
];
async function sourceFixture(state: "applied" | "rejected" | "approved" | "proposed" = "applied") {
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
  await source.mutation(anyApi.memoryChangeSets.stage, {
    serviceToken,
    projectKey: "p",
    changeSetId: "change",
    requestId: "request",
    expectedRevision: 3,
    records,
    rationale: "Test history",
    proposedBy: "agent",
  });
  if (state === "approved" || state === "applied")
    await source.mutation(anyApi.memoryChangeSets.approve, {
      serviceToken,
      projectKey: "p",
      changeSetId: "change",
      expectedRevision: 3,
    });
  if (state === "applied")
    await source.mutation(anyApi.memoryChangeSets.apply, {
      serviceToken,
      projectKey: "p",
      changeSetId: "change",
      expectedRevision: 3,
    });
  if (state === "rejected")
    await source.mutation(anyApi.memoryChangeSets.reject, {
      serviceToken,
      projectKey: "p",
      changeSetId: "change",
      reason: "No",
    });
  const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  return { source, capture };
}
function clientFor(t: ReturnType<typeof convexTest>): ConvexClientLike {
  return {
    query: t.query.bind(t) as ConvexClientLike["query"],
    mutation: () => {
      throw new Error("Verification mutation forbidden");
    },
  } as ConvexClientLike;
}
it("restores real applied memory history through ordinary reads and leaves replay inert", async () => {
  const { capture } = await sourceFixture();
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
  expect(proof.verifiedGroups).toEqual([]);
  expect(proof.completeness).toBe("partial");
  expect(proof.restoredChecksum).toBe(proof.sourceChecksum);
  const before = await target.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  const replay = await target.mutation(anyApi.memoryChangeSets.apply, {
    serviceToken,
    projectKey: "p",
    changeSetId: "change",
    expectedRevision: 3,
  });
  expect(replay.idempotent).toBe(true);
  expect(replay.project.revision).toBe(4);
  expect(replay.records).toHaveLength(4);
  const after = await target.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  expect(JSON.parse(after.payloadJson).tables).toEqual(JSON.parse(before.payloadJson).tables);
});
it("restores rejected definitions without inventing applied record references", async () => {
  const { capture } = await sourceFixture("rejected");
  const target = convexTest(schema, modules);
  const ids = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken }),
  );
  await verifyRestoredS4ProjectNotes(capture, ids, clientFor(target), serviceToken, approvalToken);
  const before = await target.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  await expect(
    target.mutation(anyApi.memoryChangeSets.apply, {
      serviceToken,
      projectKey: "p",
      changeSetId: "change",
      expectedRevision: 3,
    }),
  ).rejects.toThrow(/approved/);
  const after = await target.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  expect(JSON.parse(after.payloadJson).tables).toEqual(JSON.parse(before.payloadJson).tables);
  expect(await target.run((ctx) => ctx.db.query("projectRecords").collect())).toEqual([]);
});
it.each(["approved", "proposed"] as const)("refuses actionable %s history", async (state) => {
  const { capture } = await sourceFixture(state);
  const target = convexTest(schema, modules);
  await expect(
    target.run((ctx) => restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken })),
  ).rejects.toThrow(/terminal|actionable|unsupported/);
  expect(await target.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
});
it.each([
  "dangling-record",
  "wrong-wrapper",
  "unknown-audit",
  "missing-history",
  "wrong-audit-ref",
  "bad-revision",
  "bad-definition",
])("rejects %s before any insertion", async (kind) => {
  const { capture } = await sourceFixture();
  const payload = JSON.parse(capture.payloadJson);
  const rows = (table: string) =>
    payload.tables.find((entry: { table: string }) => entry.table === table).documents;
  if (kind === "dangling-record") rows("projectRecords").pop();
  if (kind === "wrong-wrapper") rows("projectRecords")[0].recordId = "different";
  if (kind === "unknown-audit") rows("auditEvents")[0].eventType = "unknown";
  if (kind === "missing-history") rows("auditEvents").pop();
  if (kind === "wrong-audit-ref") rows("auditEvents")[0].payload.changeSetId = "unknown";
  if (kind === "bad-revision") rows("memoryChangeSets")[0].appliedRevision = 99;
  if (kind === "bad-definition") rows("memoryChangeSets")[0].records[0].confidence = 2;
  const target = convexTest(schema, modules);
  await expect(
    target.run((ctx) =>
      restoreS4ProjectNotes(ctx, { ...encodeS4Payload(payload), serviceToken, approvalToken }),
    ),
  ).rejects.toThrow();
  expect(await target.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
});

it("preserves older applied definitions alongside a later replacement record", async () => {
  const { source } = await sourceFixture();
  await source.mutation(anyApi.memoryChangeSets.stage, {
    serviceToken,
    projectKey: "p",
    changeSetId: "later",
    requestId: "later-request",
    expectedRevision: 4,
    records: [{ ...records[0], statement: "Later observation" }],
    rationale: "New information",
    proposedBy: "agent",
  });
  await source.mutation(anyApi.memoryChangeSets.approve, {
    serviceToken,
    projectKey: "p",
    changeSetId: "later",
    expectedRevision: 4,
  });
  await source.mutation(anyApi.memoryChangeSets.apply, {
    serviceToken,
    projectKey: "p",
    changeSetId: "later",
    expectedRevision: 4,
  });
  const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  const target = convexTest(schema, modules);
  const ids = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken }),
  );
  await verifyRestoredS4ProjectNotes(capture, ids, clientFor(target), serviceToken, approvalToken);
  const old = await target.query(anyApi.memoryChangeSets.get, {
    serviceToken,
    projectKey: "p",
    changeSetId: "change",
  });
  expect(old.records[0].statement).toBe("Observed");
  const current = await target.query(anyApi.projectRecords.listByKind, {
    serviceToken,
    projectKey: "p",
    kind: "fact",
  });
  expect(current[0].record.statement).toBe("Later observation");
});

it.each(["rejectedBy", "rejectedAt", "rejectedReason"])(
  "refuses applied history with %s before insertion",
  async (field) => {
    const { capture } = await sourceFixture();
    const payload = JSON.parse(capture.payloadJson);
    const change = payload.tables.find(
      (entry: { table: string }) => entry.table === "memoryChangeSets",
    ).documents[0];
    change[field] =
      field === "rejectedAt" ? change.updatedAt : field === "rejectedBy" ? "user" : "No";
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
                insertions++;
                throw new Error("Unexpected insertion");
              },
            },
          },
          { ...encodeS4Payload(payload), serviceToken, approvalToken },
        ),
      ),
    ).rejects.toThrow(/Invalid applied memory history/);
    expect(insertions).toBe(0);
  },
);

it.each(["valid", "missing-actor", "missing-time", "invalid-time"])(
  "validates approved-then-rejected metadata: %s",
  async (variant) => {
    const { source } = await sourceFixture("approved");
    await source.mutation(anyApi.memoryChangeSets.reject, {
      serviceToken,
      projectKey: "p",
      changeSetId: "change",
      reason: "No",
    });
    const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
    const payload = JSON.parse(capture.payloadJson);
    const change = payload.tables.find(
      (entry: { table: string }) => entry.table === "memoryChangeSets",
    ).documents[0];
    if (variant === "missing-actor") delete change.approvedBy;
    if (variant === "missing-time") delete change.approvedAt;
    if (variant === "invalid-time") change.approvedAt = "invalid";
    const target = convexTest(schema, modules);
    if (variant === "valid") {
      const identities = await target.run((ctx) =>
        restoreS4ProjectNotes(ctx, { ...encodeS4Payload(payload), serviceToken, approvalToken }),
      );
      await verifyRestoredS4ProjectNotes(
        encodeS4Payload(payload),
        identities,
        clientFor(target),
        serviceToken,
        approvalToken,
      );
    } else {
      let insertions = 0;
      await expect(
        target.run((ctx) =>
          restoreS4ProjectNotes(
            {
              ...ctx,
              db: {
                ...ctx.db,
                insert: async () => {
                  insertions++;
                  throw new Error("Unexpected insertion");
                },
              },
            },
            { ...encodeS4Payload(payload), serviceToken, approvalToken },
          ),
        ),
      ).rejects.toThrow(/Invalid rejected memory history/);
      expect(insertions).toBe(0);
    }
  },
);
