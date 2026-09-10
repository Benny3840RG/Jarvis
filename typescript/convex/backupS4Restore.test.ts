import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { restoreS4ProjectNotes } from "./backupS4Restore.js";
import { verifyRestoredS4ProjectNotes } from "../src/backup/v4/restore.js";
import { encodeS4Payload, S4_CAPTURE_VERSION, S4_TABLES } from "../src/backup/v4/convexCapture.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
const serviceToken = "s4-restore-service-token-000000000000000";
const approvalToken = "s4-restore-approval-token-00000000000000";
beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", serviceToken);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", approvalToken);
});
afterEach(() => vi.unstubAllEnvs());
const project = {
  ownerId: "jarvis-cli",
  projectKey: "p",
  projectName: "Project",
  projectType: "test",
  status: "active" as const,
  createdAt: 1,
  updatedAt: 2,
  revision: 3,
  domains: ["workshop"],
  summary: "Opaque",
  preferences: {
    outputStyle: "brief",
    communicationTone: "plain",
    detailLevel: "normal",
    unitSystem: "metric" as const,
    locale: "en-AU" as const,
  },
};
const note = {
  ownerId: "jarvis-cli",
  projectId: "p",
  title: "Note",
  body: "Opaque",
  tags: [],
  domain: "workshop" as const,
  sensitivity: "private" as const,
  retention: "long_term" as const,
  idempotencyKey: "note-key",
  actionFingerprint: "note-fingerprint",
  sourceRequestId: "request",
  correlationId: "correlation",
  source: "test",
  revision: 4,
  createdAt: 1,
  updatedAt: 2,
};
async function captured() {
  const source = convexTest(schema, modules);
  await source.run(async (ctx) => {
    // Give the source a different physical-ID sequence from the fresh destination.
    const discarded = await ctx.db.insert("projects", { ...project, projectKey: "discarded" });
    await ctx.db.delete("projects", discarded);
    const id = await ctx.db.insert("projects", project);
    await ctx.db.insert("notes", { ...note, body: String(id) });
  });
  const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  return { source, capture };
}
function clientFor(t: ReturnType<typeof convexTest>): ConvexClientLike {
  return {
    query: t.query.bind(t) as ConvexClientLike["query"],
    mutation: () => {
      throw new Error("Verification must not mutate.");
    },
  } as ConvexClientLike;
}
it("restores an isolated typed graph and verifies real normal reads and digests", async () => {
  const { capture } = await captured();
  const target = convexTest(schema, modules);
  const identities = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken }),
  );
  expect(identities.projects[0]?.targetId).not.toBe(identities.projects[0]?.sourceId);
  const proof = await verifyRestoredS4ProjectNotes(
    capture,
    identities,
    clientFor(target),
    serviceToken,
    approvalToken,
  );
  expect(proof.completeness).toBe("partial");
  expect(proof.verifiedGroups).toEqual([]);
  expect(proof.restoredChecksum).toBe(proof.sourceChecksum);
  const row = await target.query(anyApi.notes.get, {
    serviceToken,
    projectId: "p",
    id: identities.notes[0]?.targetId,
  });
  expect(row.body).toBe(identities.projects[0]?.sourceId);
  expect(row.revision).toBe(4);
  const {
    ownerId: _owner,
    revision: _revision,
    createdAt: _created,
    updatedAt: _updated,
    ...createInput
  } = note;
  const replay = await target.mutation(anyApi.notes.create, {
    ...createInput,
    body: row.body,
    serviceToken,
  });
  expect(replay._id).toBe(row._id);
  await expect(
    target.mutation(anyApi.notes.create, {
      ...createInput,
      serviceToken,
      actionFingerprint: "different",
    }),
  ).rejects.toThrow(/fingerprint/);
});
it("refuses nonempty destination including unrelated domains", async () => {
  const { capture } = await captured();
  const target = convexTest(schema, modules);
  await target.run((ctx) => ctx.db.insert("projects", { ...project, ownerId: "other" }));
  await expect(
    target.run((ctx) => restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken })),
  ).rejects.toThrow(/empty/);
  expect(await target.run((ctx) => ctx.db.query("notes").collect())).toEqual([]);
});
it("refuses wrong approval before any write", async () => {
  const { capture } = await captured();
  const target = convexTest(schema, modules);
  await expect(
    target.run((ctx) =>
      restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken: "wrong" }),
    ),
  ).rejects.toThrow(/Unauthorized/);
  expect(await target.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
});
it("detects modified restored bytes from ordinary reads", async () => {
  const { capture } = await captured();
  const target = convexTest(schema, modules);
  const ids = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken }),
  );
  await target.run((ctx) => ctx.db.patch("notes", ids.notes[0]!.targetId, { body: "corrupt" }));
  await expect(
    verifyRestoredS4ProjectNotes(capture, ids, clientFor(target), serviceToken, approvalToken),
  ).rejects.toThrow(/checksum|match/);
});
it("rejects corrupt capture checksum and missing inventory", async () => {
  const { capture } = await captured();
  const target = convexTest(schema, modules);
  await expect(
    target.run((ctx) =>
      restoreS4ProjectNotes(ctx, {
        ...capture,
        payloadSha256: "0".repeat(64),
        serviceToken,
        approvalToken,
      }),
    ),
  ).rejects.toThrow(/checksum/);
  const incomplete = encodeS4Payload({
    version: S4_CAPTURE_VERSION,
    provider: "convex",
    ownerId: "jarvis-cli",
    capturedAt: 1,
    tables: [],
  });
  await expect(
    target.run((ctx) => restoreS4ProjectNotes(ctx, { ...incomplete, serviceToken, approvalToken })),
  ).rejects.toThrow(/inventory/);
});
it.each(["unsupported", "dangling", "duplicate", "foreign"])(
  "rejects %s source before materialization",
  async (kind) => {
    const { capture } = await captured();
    const body = JSON.parse(capture.payloadJson);
    const projects = body.tables.find((t: { table: string }) => t.table === "projects");
    const notes = body.tables.find((t: { table: string }) => t.table === "notes");
    if (kind === "unsupported")
      body.tables.find((t: { table: string }) => t.table === "toolActions").documents = [
        { _id: "unsupported" },
      ];
    if (kind === "dangling") notes.documents[0].projectId = "missing";
    if (kind === "duplicate") notes.documents.push({ ...notes.documents[0], _id: "duplicate" });
    if (kind === "foreign") projects.documents[0].ownerId = "foreign";
    const target = convexTest(schema, modules);
    const encoded = encodeS4Payload(body);
    await expect(
      target.run((ctx) => restoreS4ProjectNotes(ctx, { ...encoded, serviceToken, approvalToken })),
    ).rejects.toThrow(/unsupported|reference|duplicate|owner/i);
    expect(await target.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
  },
);
it("empty capture stays a partial slice, never whole-group coverage", async () => {
  const capture = encodeS4Payload({
    version: S4_CAPTURE_VERSION,
    provider: "convex",
    ownerId: "jarvis-cli",
    capturedAt: 1,
    tables: S4_TABLES.map((table) => ({ table, documents: [] })),
  });
  const target = convexTest(schema, modules);
  const ids = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken }),
  );
  expect(
    (
      await verifyRestoredS4ProjectNotes(
        capture,
        ids,
        clientFor(target),
        serviceToken,
        approvalToken,
      )
    ).verifiedGroups,
  ).toEqual([]);
});

it("rolls back insertion failure without exposing a partial target", async () => {
  const { capture } = await captured();
  const target = convexTest(schema, modules);
  await expect(
    target.run((ctx) =>
      restoreS4ProjectNotes(
        {
          ...ctx,
          db: {
            ...ctx.db,
            insert: (async (...args: Parameters<typeof ctx.db.insert>) => {
              if (args[0] === "notes") throw new Error("injected interruption");
              return ctx.db.insert(...args);
            }) as typeof ctx.db.insert,
          },
        },
        { ...capture, serviceToken, approvalToken },
      ),
    ),
  ).rejects.toThrow(/injected interruption/);
  expect(await target.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
  const ids = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken }),
  );
  expect(
    (
      await verifyRestoredS4ProjectNotes(
        capture,
        ids,
        clientFor(target),
        serviceToken,
        approvalToken,
      )
    ).restoredChecksum,
  ).toMatch(/^sha256:/);
});

it("rejects unknown document fields through the existing persisted schema", async () => {
  const { capture } = await captured();
  const payload = JSON.parse(capture.payloadJson);
  payload.tables.find(
    (entry: { table: string }) => entry.table === "notes",
  ).documents[0].unrecognized = "reject";
  const target = convexTest(schema, modules);
  await expect(
    target.run((ctx) =>
      restoreS4ProjectNotes(ctx, { ...encodeS4Payload(payload), serviceToken, approvalToken }),
    ),
  ).rejects.toThrow();
  expect(await target.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
});

it("refuses extra restored rows rather than verifying only the expected subset", async () => {
  const { capture } = await captured();
  const target = convexTest(schema, modules);
  const ids = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken }),
  );
  await target.run((ctx) => ctx.db.insert("notes", { ...note, idempotencyKey: "unexpected" }));
  await expect(
    verifyRestoredS4ProjectNotes(capture, ids, clientFor(target), serviceToken, approvalToken),
  ).rejects.toThrow(/count|extra|match/);
});

it("does not collapse tagged numeric history in restored checksums", async () => {
  const { source } = await captured();
  await source.run(async (ctx) => {
    const row = await ctx.db.query("notes").first();
    if (!row) throw new Error("fixture missing");
    await ctx.db.patch("notes", row._id, { createdAt: -0 });
  });
  const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  const target = convexTest(schema, modules);
  const ids = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken }),
  );
  await target.run((ctx) => ctx.db.patch("notes", ids.notes[0]!.targetId, { createdAt: 0 }));
  await expect(
    verifyRestoredS4ProjectNotes(capture, ids, clientFor(target), serviceToken, approvalToken),
  ).rejects.toThrow(/checksum|match/);
});

it("rejects changed restored ordering even when mapped row contents still match", async () => {
  const { source } = await captured();
  await source.run((ctx) => ctx.db.insert("notes", { ...note, idempotencyKey: "second" }));
  const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  const target = convexTest(schema, modules);
  const ids = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken }),
  );
  await target.run(async (ctx) => {
    const row = await ctx.db.get("notes", ids.notes[0]!.targetId);
    if (!row) throw new Error("missing");
    const { _id, _creationTime: _time, ...fields } = row;
    await ctx.db.delete("notes", _id);
    ids.notes[0]!.targetId = await ctx.db.insert("notes", fields);
  });
  await expect(
    verifyRestoredS4ProjectNotes(capture, ids, clientFor(target), serviceToken, approvalToken),
  ).rejects.toThrow(/order/);
});
