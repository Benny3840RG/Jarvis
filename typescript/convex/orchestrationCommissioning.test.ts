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
    await t.mutation(api.orchestrationState.markStepRunning, {
      serviceToken: SERVICE_TOKEN,
      runId: "run-a",
      nodeId: "probe",
      operationId: "commissioningProbe",
      workerId: "worker-1",
      leaseTtlMs: 1_000,
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
