import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { restoreS4ProjectNotes } from "./backupS4Restore.js";
import { verifyRestoredS4ProjectNotes } from "../src/backup/v4/restore.js";
import { encodeS4Payload } from "../src/backup/v4/convexCapture.js";
import { ConvexToolActionService } from "../src/persistence/convexToolActions.js";
import { ConvexToolExecutionReceiptStore } from "../src/persistence/convexToolExecutionReceipts.js";
import { createNoteToolDefinition } from "../src/actions/createNoteTool.js";
import {
  ToolExecutionService,
  fingerprintToolAction,
  fingerprintToolEffect,
} from "../src/actions/toolExecution.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
const serviceToken = "rejected-restore-service-token-00000000000";
const approvalToken = "rejected-restore-approval-token-0000000000";
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
async function fixture() {
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
  const capture = await source.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  return { source, capture };
}
function clientFor(t: ReturnType<typeof convexTest>): ConvexClientLike {
  return { query: t.query.bind(t), mutation: t.mutation.bind(t) } as ConvexClientLike;
}
it("restores rejected note proposals, preserves hashes and audits, and denies execution without effects", async () => {
  const { source, capture } = await fixture();
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
  expect(ids.toolActions[0]!.targetId).not.toBe(ids.toolActions[0]!.sourceId);
  expect(proof.completeness).toBe("partial");
  expect(proof.verifiedGroups).toEqual([]);
  const sourceAction = await new ConvexToolActionService(clientFor(source), serviceToken).get({
    projectId: "p",
    actionId: "action",
  });
  const action = await new ConvexToolActionService(clientFor(target), serviceToken).get({
    projectId: "p",
    actionId: "action",
  });
  expect(action).toEqual(sourceAction);
  expect(fingerprintToolAction(action!)).toBe(fingerprintToolAction(sourceAction!));
  expect(fingerprintToolEffect(action!)).toBe(fingerprintToolEffect(sourceAction!));
  const before = await target.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  await expect(
    target.mutation(anyApi.toolActions.approve, {
      serviceToken,
      approvalToken,
      projectKey: "p",
      actionId: "action",
      expectedRevision: 3,
    }),
  ).rejects.toThrow(/rejected/i);
  await target.mutation(anyApi.toolActions.reject, {
    serviceToken,
    projectKey: "p",
    actionId: "action",
    reason: " No ",
  });
  await target.mutation(anyApi.toolActions.stage, proposal);
  const replayed = await target.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  expect(JSON.parse(replayed.payloadJson).tables).toEqual(JSON.parse(before.payloadJson).tables);
  const create = vi.fn(async () => {
    throw new Error("Tool must not execute");
  });
  const executor = new ToolExecutionService(
    [createNoteToolDefinition({ create } as never)],
    new ConvexToolExecutionReceiptStore(clientFor(target), serviceToken),
  );
  const receipt = await executor.execute({
    action: action!,
    authority: "T1",
    idempotencyKey: "denial",
  });
  expect(receipt.status).toBe("blocked");
  expect(receipt.errorCode).toBe("not-authorized");
  expect(create).not.toHaveBeenCalled();
  const after = await target.query(anyApi.backupS4.capture, { serviceToken, approvalToken });
  const beforeTables = JSON.parse(before.payloadJson).tables;
  const afterTables = JSON.parse(after.payloadJson).tables;
  for (const entry of afterTables) {
    if (entry.table === "toolExecutionReceipts") {
      expect(entry.documents).toHaveLength(1);
      expect(entry.documents[0]).toMatchObject({
        actionId: "action",
        status: "blocked",
        errorCode: "not-authorized",
        actionFingerprint: fingerprintToolAction(action!),
      });
    } else
      expect(entry).toEqual(
        beforeTables.find((old: { table: string }) => old.table === entry.table),
      );
  }
});
it.each([
  "approvedBy",
  "approvedAt",
  "approvalExpiryPolicy",
  "approvalExpiresAt",
  "expiredObservedAt",
  "consumptionPolicy",
  "revokedBy",
  "revokedReason",
  "revokedAt",
  "singleUseClaimedAt",
  "singleUseClaimId",
])("refuses authority metadata %s before insertion", async (field) => {
  const { capture } = await fixture();
  const payload = JSON.parse(capture.payloadJson);
  payload.tables.find((x: { table: string }) => x.table === "toolActions").documents[0][field] = 1;
  const target = convexTest(schema, modules);
  let inserts = 0;
  await expect(
    target.run((ctx) =>
      restoreS4ProjectNotes(
        {
          ...ctx,
          db: {
            ...ctx.db,
            insert: async () => {
              inserts++;
              throw new Error("Unexpected insertion");
            },
          },
        },
        { ...encodeS4Payload(payload), serviceToken, approvalToken },
      ),
    ),
  ).rejects.toThrow(/rejected action|Unsupported/i);
  expect(inserts).toBe(0);
});
it.each([
  "active-state",
  "other-tool",
  "target-argument",
  "missing-audit",
  "wrong-reason",
  "bad-safety",
  "dangling-project",
  "duplicate-scope",
  "extra-audit",
  "padded-reason",
])("refuses %s before insertion", async (variant) => {
  const { capture } = await fixture();
  const payload = JSON.parse(capture.payloadJson);
  const rows = (table: string) =>
    payload.tables.find((x: { table: string }) => x.table === table).documents;
  const action = rows("toolActions")[0];
  if (variant === "active-state") action.state = "proposed";
  if (variant === "other-tool") action.tool = "tasks";
  if (variant === "target-argument") action.arguments.taskId = "physical-id";
  if (variant === "missing-audit") rows("auditEvents").pop();
  if (variant === "wrong-reason")
    rows("auditEvents").find(
      (x: { eventType: string }) => x.eventType === "tool.action.rejected",
    ).payload.reason = "Other";
  if (variant === "bad-safety") action.safetyBinding.status = "blocked";
  if (variant === "dangling-project") action.projectKey = "missing";
  if (variant === "duplicate-scope")
    rows("toolActions").push({ ...action, _id: action._id + "z", actionId: "other" });
  if (variant === "extra-audit") rows("auditEvents")[0].eventType = "tool.action.approved";
  if (variant === "padded-reason") {
    action.rejectedReason = " No ";
    rows("auditEvents").find(
      (x: { eventType: string }) => x.eventType === "tool.action.rejected",
    ).payload.reason = " No ";
  }
  const target = convexTest(schema, modules);
  let inserts = 0;
  await expect(
    target.run((ctx) =>
      restoreS4ProjectNotes(
        {
          ...ctx,
          db: {
            ...ctx.db,
            insert: async () => {
              inserts++;
              throw new Error("Unexpected insertion");
            },
          },
        },
        { ...encodeS4Payload(payload), serviceToken, approvalToken },
      ),
    ),
  ).rejects.toThrow(/rejected action|Unsupported|Audit/i);
  expect(inserts).toBe(0);
});
