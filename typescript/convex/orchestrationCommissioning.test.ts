import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "orchestration-commissioning-test-token-000000";
const CAMPAIGN = "commissioning-campaign-abc";

function harness() {
  return convexTest(schema, modules);
}

function begin(overrides: Record<string, unknown> = {}) {
  return {
    serviceToken: SERVICE_TOKEN,
    runId: "run-1",
    triggerId: "trigger-1",
    triggerSource: "http" as const,
    triggerKind: "isolated-ingress-probe",
    idempotencyKey: "probe-key-1",
    requestFingerprint: "request-fp-1",
    planFingerprint: "plan-fp-1",
    triggerPayload: { campaignId: CAMPAIGN },
    authority: "T1" as const,
    policyVersion: "commissioning-isolated-ingress:v1",
    policyFingerprint: "commissioning-policy-fp-1",
    nodeIds: ["probe"],
    maxRetries: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("purgeCommissioningRun", () => {
  it("deletes a campaign-matching commissioning run and its steps", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin({ runId: "run-a" }));
    const lease = await t.mutation(api.orchestrationState.markStepRunning, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-a",
      nodeId: "probe",
      operationId: "commissioningProbe",
      workerId: "worker-1",
      leaseTtlMs: 1_000,
    });

    await expect(
      t.mutation(api.orchestrationCommissioning.purgeCommissioningRun, {
        serviceToken: SERVICE_TOKEN,
        campaignId: CAMPAIGN,
        runIds: ["run-a"],
      }),
    ).rejects.toThrow(/nonterminal|active|lease/i);
    await t.mutation(api.orchestrationState.recordStepSuccess, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-a",
      nodeId: "probe",
      workerId: "worker-1",
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
    });

    const result = await t.mutation(api.orchestrationCommissioning.purgeCommissioningRun, {
      serviceToken: SERVICE_TOKEN,
      campaignId: CAMPAIGN,
      runIds: ["run-a", "run-missing"],
    });

    expect(result.deleted).toEqual([{ runId: "run-a", steps: 1, reconciliations: 0 }]);
    expect(result.notFound).toEqual(["run-missing"]);
    expect(
      await t.query(api.orchestrationState.getRun, { serviceToken: SERVICE_TOKEN, runId: "run-a" }),
    ).toBeNull();
  });

  it("refuses a run that is not a commissioning-campaign member and deletes nothing", async () => {
    const t = harness();
    await t.mutation(
      api.orchestrationState.beginRun,
      begin({ runId: "run-real", policyVersion: "policy:v1", idempotencyKey: "k-real" }),
    );

    await expect(
      t.mutation(api.orchestrationCommissioning.purgeCommissioningRun, {
        serviceToken: SERVICE_TOKEN,
        campaignId: CAMPAIGN,
        runIds: ["run-real"],
      }),
    ).rejects.toThrow(/not a member of commissioning campaign/);

    expect(
      await t.query(api.orchestrationState.getRun, {
        serviceToken: SERVICE_TOKEN,
        runId: "run-real",
      }),
    ).not.toBeNull();
  });

  it("refuses a run stamped with a different campaign id", async () => {
    const t = harness();
    await t.mutation(
      api.orchestrationState.beginRun,
      begin({ runId: "run-other", triggerPayload: { campaignId: "other-campaign" } }),
    );

    await expect(
      t.mutation(api.orchestrationCommissioning.purgeCommissioningRun, {
        serviceToken: SERVICE_TOKEN,
        campaignId: CAMPAIGN,
        runIds: ["run-other"],
      }),
    ).rejects.toThrow(/not a member of commissioning campaign/);
  });

  it("rejects a foreign service token", async () => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin({ runId: "run-z" }));
    await expect(
      t.mutation(api.orchestrationCommissioning.purgeCommissioningRun, {
        serviceToken: "not-the-configured-token-aaaaaaaaaaaaaaaaaaa",
        campaignId: CAMPAIGN,
        runIds: ["run-z"],
      }),
    ).rejects.toThrow();
  });
});

it("preserves terminal runs carrying a live lease", async () => {
  const t = harness();
  await t.mutation(api.orchestrationState.beginRun, begin());
  await t.run(async (ctx) => {
    const run = await ctx.db.query("orchestrationRuns").first();
    const step = await ctx.db.query("orchestrationSteps").first();
    if (!run || !step) throw new Error("fixture missing");
    await ctx.db.patch("orchestrationRuns", run._id, { state: "succeeded" });
    await ctx.db.patch("orchestrationSteps", step._id, {
      state: "succeeded",
      leaseExpiresAt: Date.now() + 1_000,
    });
  });
  await expect(
    t.mutation(api.orchestrationCommissioning.purgeCommissioningRun, {
      serviceToken: SERVICE_TOKEN,
      campaignId: CAMPAIGN,
      runIds: ["run-1"],
    }),
  ).rejects.toThrow(/active lease/);
  expect(
    await t.query(api.orchestrationState.getRun, { serviceToken: SERVICE_TOKEN, runId: "run-1" }),
  ).not.toBeNull();
});

it.each(["queued", "running", "indeterminate"] as const)(
  "preserves %s campaign runs",
  async (state) => {
    const t = harness();
    await t.mutation(api.orchestrationState.beginRun, begin());
    await t.run(async (ctx) => {
      const run = await ctx.db.query("orchestrationRuns").first();
      if (!run) throw new Error("missing");
      await ctx.db.patch("orchestrationRuns", run._id, { state });
    });
    await expect(
      t.mutation(api.orchestrationCommissioning.purgeCommissioningRun, {
        serviceToken: SERVICE_TOKEN,
        campaignId: CAMPAIGN,
        runIds: ["run-1"],
      }),
    ).rejects.toThrow(/nonterminal|unresolved/);
  },
);
