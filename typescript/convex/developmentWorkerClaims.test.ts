import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const token = "development-worker-test-service-token-00000";
afterEach(() => vi.unstubAllEnvs());
it("renews only a live bound worker lease and pauses only after its durable checkpoint", async () => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", token);
  const t = convexTest(schema, modules);
  await t.mutation(api.orchestrationState.beginRun, {
    serviceToken: token,
    runId: "run",
    triggerId: "trigger",
    triggerSource: "http",
    triggerKind: "github-development-mission",
    idempotencyKey: "issue",
    requestFingerprint: "spec",
    planFingerprint: "plan",
    triggerPayload: {},
    authority: "T2",
    policyVersion: "v1",
    policyFingerprint: "policy",
    nodeIds: ["worker"],
    maxRetries: 2,
  });
  await t.mutation(api.developmentState.create, {
    serviceToken: token,
    subjectId: "mission",
    orchestrationRunId: "run",
    orchestrationNodeId: "worker",
    repository: "o/r",
    branch: "main",
  });
  const grant = await t.mutation(api.orchestrationState.markStepRunning, {
    serviceToken: token,
    runId: "run",
    nodeId: "worker",
    operationId: "github-development-worker",
    workerId: "actions:1",
    leaseTtlMs: 60_000,
  });
  const args = { serviceToken: token, subjectId: "mission", workerId: "actions:1" };
  await expect(
    t.mutation(makeFunctionReference<"mutation">("developmentWorkerClaims:renew"), {
      ...args,
      workerId: "actions:2",
    }),
  ).rejects.toThrow();
  await expect(
    t.mutation(makeFunctionReference<"mutation">("developmentWorkerClaims:pause"), args),
  ).rejects.toThrow();
  await t.run(async (ctx) => {
    const subject = await ctx.db.query("developmentSubjects").first();
    await ctx.db.patch("developmentSubjects", subject!._id, { state: "BUILDING" });
  });
  const lease = await t.mutation(
    makeFunctionReference<"mutation">("developmentWorkerClaims:renew"),
    args,
  );
  expect(lease.leaseToken).toBe(grant.leaseToken);
  expect(lease.fencingToken).toBe(grant.fencingToken);
  await t.run(async (ctx) => {
    const subject = await ctx.db.query("developmentSubjects").first();
    await ctx.db.patch("developmentSubjects", subject!._id, { state: "VERIFYING" });
  });
  await t.mutation(makeFunctionReference<"mutation">("developmentWorkerClaims:pause"), args);
  await expect(
    t.mutation(makeFunctionReference<"mutation">("developmentWorkerClaims:renew"), args),
  ).rejects.toThrow();
  const next = await t.mutation(api.orchestrationState.markStepRunning, {
    serviceToken: token,
    runId: "run",
    nodeId: "worker",
    operationId: "github-development-worker",
    workerId: "actions:2",
    leaseTtlMs: 60_000,
  });
  expect(next.fencingToken).toBe(grant.fencingToken + 1);
});
