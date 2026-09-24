import { anyApi } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { encodeS4Payload } from "../src/backup/v4/convexCapture.js";
import { verifyRestoredS4ProjectNotes } from "../src/backup/v4/restore.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { restoreS4ProjectNotes } from "./backupS4Restore.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const serviceToken = "component-risk-service-token-0000000000";
const approvalToken = "component-risk-approval-token-000000000";

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", serviceToken);
  vi.stubEnv("JARVIS_APPROVAL_TOKEN", approvalToken);
});
afterEach(() => vi.unstubAllEnvs());

function clientFor(t: ReturnType<typeof convexTest>): ConvexClientLike {
  return {
    query: t.query.bind(t) as ConvexClientLike["query"],
    mutation: () => {
      throw new Error("Verification must not mutate.");
    },
  } as ConvexClientLike;
}

const project = {
  serviceToken,
  projectKey: "p",
  projectName: "Project",
  projectType: "test",
  status: "active" as const,
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
  revision: 1,
  domains: ["workshop"],
  summary: "",
  preferences: {
    outputStyle: "brief",
    communicationTone: "plain",
    detailLevel: "normal",
    unitSystem: "metric" as const,
    locale: "en-AU" as const,
  },
};

async function sourceWithClosedRows() {
  const source = convexTest(schema, modules);
  await source.mutation(anyApi.projects.upsert, project);
  await source.run(async (ctx) => {
    // Advance the source physical-id sequence so the destination cannot reuse it.
    const discarded = await ctx.db.insert("projectRecords", {
      ownerId: "jarvis-cli",
      projectKey: "p",
      kind: "component",
      recordId: "discarded",
      record: {
        kind: "component",
        recordId: "discarded",
        name: "Discarded",
        type: "part",
        status: "planned",
        parentComponentId: null,
        attributes: {},
        notes: "",
      },
      updatedAt: 1,
    });
    await ctx.db.delete("projectRecords", discarded);
  });
  await source.mutation(anyApi.projectRecords.upsert, {
    serviceToken,
    projectKey: "p",
    record: {
      kind: "component",
      recordId: "root",
      name: "Frame",
      type: "assembly",
      status: "planned",
      parentComponentId: null,
      attributes: {},
      notes: "",
    },
  });
  await source.mutation(anyApi.projectRecords.upsert, {
    serviceToken,
    projectKey: "p",
    record: {
      kind: "component",
      recordId: "child",
      name: "Bracket",
      type: "part",
      status: "planned",
      parentComponentId: "root",
      attributes: {},
      notes: "keep-this-text",
    },
  });
  await source.mutation(anyApi.projectRecords.upsert, {
    serviceToken,
    projectKey: "p",
    record: {
      kind: "risk",
      recordId: "pinch",
      hazard: "Pinch point",
      likelihood: 2,
      consequence: 4,
      controls: ["Guard"],
      residualRisk: "low",
    },
  });
  const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  return { source, capture };
}

function documents(
  payload: { tables: Array<{ table: string; documents: unknown[] }> },
  table: string,
) {
  const entry = payload.tables.find((candidate) => candidate.table === table);
  if (!entry) throw new Error(`Missing ${table}`);
  return entry.documents;
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

it("restores closed components and risks without remapping logical edges", async () => {
  const { capture } = await sourceWithClosedRows();
  const payload = JSON.parse(capture.payloadJson);
  const records = documents(payload, "projectRecords") as Array<{
    _id: string;
    recordId: string;
    record: { notes?: string; parentComponentId?: string | null };
  }>;
  const root = records.find((row) => row.recordId === "root");
  const child = records.find((row) => row.recordId === "child");
  if (!root || !child) throw new Error("Fixture rows missing.");
  child.record.notes = root._id;
  const material = encodeS4Payload(payload);
  const target = convexTest(schema, modules);
  const ids = await target.run((ctx) =>
    restoreS4ProjectNotes(ctx, { ...material, serviceToken, approvalToken }),
  );
  expect(ids.projectRecords.every((mapping) => mapping.targetId !== mapping.sourceId)).toBe(true);
  const proof = await verifyRestoredS4ProjectNotes(
    material,
    ids,
    clientFor(target),
    serviceToken,
    approvalToken,
  );
  expect(proof.completeness).toBe("partial");
  expect(proof.verifiedGroups).toEqual([]);
  expect(proof.restoredChecksum).toBe(proof.sourceChecksum);
  const restored = await target.query(anyApi.projectRecords.listByKind, {
    serviceToken,
    projectKey: "p",
    kind: "component",
    limit: 100,
  });
  const restoredChild = restored.find((row: { recordId: string }) => row.recordId === "child");
  const restoredRoot = restored.find((row: { recordId: string }) => row.recordId === "root");
  expect(restoredChild.record.parentComponentId).toBe("root");
  expect(restoredChild.record.notes).toBe(root._id);
  expect(restoredChild._id).not.toBe(child._id);
  expect(restoredRoot._id).not.toBe(root._id);
  expect(restoredChild.record.parentComponentId).not.toBe(restoredRoot._id);
  const risks = await target.query(anyApi.projectRecords.listByKind, {
    serviceToken,
    projectKey: "p",
    kind: "risk",
    limit: 100,
  });
  expect(risks).toHaveLength(1);
  expect(risks[0].record).toMatchObject({
    recordId: "pinch",
    hazard: "Pinch point",
    likelihood: 2,
    consequence: 4,
    controls: ["Guard"],
    residualRisk: "low",
  });
});

it("refuses a nonempty destination before inserting components", async () => {
  const { capture } = await sourceWithClosedRows();
  const target = convexTest(schema, modules);
  await target.mutation(anyApi.projects.upsert, { ...project, projectKey: "occupied" });
  await expect(
    target.run((ctx) => restoreS4ProjectNotes(ctx, { ...capture, serviceToken, approvalToken })),
  ).rejects.toThrow(/empty application database/);
  expect(await target.run((ctx) => ctx.db.query("projectRecords").collect())).toEqual([]);
});

it("refuses a source owner that does not match the restore token", async () => {
  const { capture } = await sourceWithClosedRows();
  const payload = JSON.parse(capture.payloadJson);
  payload.ownerId = "other-owner";
  for (const table of payload.tables) {
    for (const row of table.documents) row.ownerId = "other-owner";
  }
  await expectRefusal(payload, /source owner does not match/);
});

it("does not translate a parent that equals a source physical id", async () => {
  const { capture } = await sourceWithClosedRows();
  const payload = JSON.parse(capture.payloadJson);
  const records = documents(payload, "projectRecords") as Array<{
    _id: string;
    recordId: string;
    record: { parentComponentId?: string | null };
  }>;
  const root = records.find((row) => row.recordId === "root");
  const child = records.find((row) => row.recordId === "child");
  if (!root || !child) throw new Error("Fixture rows missing.");
  child.record.parentComponentId = root._id;
  await expectRefusal(payload, /Unresolved component parent reference/);
});

it.each([
  ["attributes", { material: "oak" }],
  ["blank-name", " "],
  ["cycle", "cycle"],
  ["dangling-parent", "missing"],
  ["parent-is-risk", "pinch"],
  ["self-parent", "child"],
  ["other-project-parent", "root"],
] as const)("refuses component case %s before insertion", async (variant, value) => {
  const { source, capture } = await sourceWithClosedRows();
  if (variant === "cycle") {
    await source.mutation(anyApi.projectRecords.upsert, {
      serviceToken,
      projectKey: "p",
      record: {
        kind: "component",
        recordId: "root",
        name: "Frame",
        type: "assembly",
        status: "planned",
        parentComponentId: "child",
        attributes: {},
        notes: "",
      },
    });
  }
  if (variant === "other-project-parent") {
    await source.mutation(anyApi.projects.upsert, { ...project, projectKey: "q" });
    await source.mutation(anyApi.projectRecords.upsert, {
      serviceToken,
      projectKey: "q",
      record: {
        kind: "component",
        recordId: "q-child",
        name: "Remote",
        type: "part",
        status: "planned",
        parentComponentId: "root",
        attributes: {},
        notes: "",
      },
    });
  }
  const fresh =
    variant === "cycle" || variant === "other-project-parent"
      ? await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken })
      : capture;
  const payload = JSON.parse(fresh.payloadJson);
  if (
    variant === "attributes" ||
    variant === "blank-name" ||
    variant === "dangling-parent" ||
    variant === "parent-is-risk" ||
    variant === "self-parent"
  ) {
    const child = (
      documents(payload, "projectRecords") as Array<{
        recordId: string;
        record: {
          name: string;
          attributes: Record<string, unknown>;
          parentComponentId: string | null;
        };
      }>
    ).find((row) => row.recordId === "child");
    if (!child) throw new Error("Child missing.");
    if (variant === "attributes") child.record.attributes = value as Record<string, unknown>;
    if (variant === "blank-name") child.record.name = value as string;
    if (variant === "dangling-parent" || variant === "parent-is-risk" || variant === "self-parent")
      child.record.parentComponentId = value as string;
  }
  const pattern =
    variant === "attributes"
      ? /unclassified/
      : variant === "blank-name"
        ? /canonical/
        : variant === "cycle" || variant === "self-parent"
          ? /cycle/
          : /Unresolved component parent reference/;
  await expectRefusal(payload, pattern);
});

it.each([
  ["fractional", 1.5],
  ["zero", 0],
  ["six", 6],
  ["padded-hazard", " Pinch "],
  ["blank-control", " "],
] as const)("refuses risk case %s before insertion", async (variant, value) => {
  const { capture } = await sourceWithClosedRows();
  const payload = JSON.parse(capture.payloadJson);
  const risk = (
    documents(payload, "projectRecords") as Array<{
      kind: string;
      record: { likelihood: number; hazard: string; controls: string[] };
    }>
  ).find((row) => row.kind === "risk");
  if (!risk) throw new Error("Risk missing.");
  if (variant === "fractional" || variant === "zero" || variant === "six")
    risk.record.likelihood = value as number;
  if (variant === "padded-hazard") risk.record.hazard = value as string;
  if (variant === "blank-control") risk.record.controls = [value as string];
  await expectRefusal(
    payload,
    variant === "padded-hazard"
      ? /hazard is not canonical/
      : variant === "blank-control"
        ? /controls must be canonical/
        : /integers from 1 to 5/,
  );
});

it.each(["task", "constraint", "event"] as const)(
  "refuses unclassified %s records before insertion",
  async (kind) => {
    const source = convexTest(schema, modules);
    await source.mutation(anyApi.projects.upsert, project);
    const record =
      kind === "task"
        ? {
            kind,
            recordId: "task-1",
            title: "Cut",
            status: "done" as const,
            dependencies: [] as string[],
            owner: "user",
            dueAt: null,
          }
        : kind === "constraint"
          ? {
              kind,
              recordId: "budget",
              type: "budget" as const,
              value: 10,
              hardConstraint: true,
            }
          : {
              kind,
              recordId: "noted",
              eventType: "noted",
              actor: "user" as const,
              timestamp: "2026-09-11T00:00:00.000Z",
              payload: {},
            };
    await source.mutation(anyApi.projectRecords.upsert, {
      serviceToken,
      projectKey: "p",
      record,
    });
    const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
    await expectRefusal(
      JSON.parse(capture.payloadJson),
      /Unsupported or inconsistent project memory record reference/,
    );
  },
);

it("refuses a component definition smuggled into memory change history", async () => {
  const { capture } = await sourceWithClosedRows();
  const payload = JSON.parse(capture.payloadJson);
  const changes = documents(payload, "memoryChangeSets") as Array<{ records: unknown[] }>;
  if (changes.length !== 0) throw new Error("Fixture must not already contain change sets.");
  payload.tables.find((entry: { table: string }) => entry.table === "memoryChangeSets").documents =
    [
      {
        _id: "memoryChangeSets;smuggled",
        _creationTime: 10,
        ownerId: "jarvis-cli",
        changeSetId: "smuggled",
        requestId: "request",
        projectKey: "p",
        baseRevision: 1,
        state: "applied",
        records: [
          {
            kind: "component",
            recordId: "root",
            name: "Frame",
            type: "assembly",
            status: "planned",
            parentComponentId: null,
            attributes: {},
            notes: "",
          },
        ],
        rationale: "No",
        proposedBy: "agent",
        createdAt: 10,
        updatedAt: 10,
        approvedBy: "user",
        approvedAt: 10,
        appliedAt: 10,
        appliedRevision: 2,
      },
    ];
  await expectRefusal(payload, /Invalid or duplicate memory definition identity/);
});

it("refuses more than the ordinary 100-row component group", async () => {
  const { capture } = await sourceWithClosedRows();
  const payload = JSON.parse(capture.payloadJson);
  const records = documents(payload, "projectRecords") as Array<Record<string, unknown>>;
  const root = records.find((row) => row.recordId === "root");
  if (!root) throw new Error("Root missing.");
  for (
    let index = records.filter((row) => row.kind === "component").length;
    index < 101;
    index += 1
  ) {
    records.push({
      ...root,
      _id: `projectRecords;extra${index}`,
      _creationTime: Number(root._creationTime) + index + 1,
      recordId: `extra-${index}`,
      record: {
        ...(root.record as object),
        recordId: `extra-${index}`,
        parentComponentId: "root",
      },
    });
  }
  records.sort((left, right) => {
    const time = Number(left._creationTime) - Number(right._creationTime);
    if (time !== 0) return time;
    return String(left._id).localeCompare(String(right._id));
  });
  await expectRefusal(payload, /ordinary read limit of 100/);
});
