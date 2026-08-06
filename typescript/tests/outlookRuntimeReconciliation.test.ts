import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExternalReconciliationStore } from "../src/reconciliation/externalReconciliation.js";
import { createOutlookRuntimeReconciliationFactories } from "../src/reconciliation/outlookRuntimeReconciliation.js";
import type { MicrosoftOutlookRuntime } from "../src/auth/microsoftOutlookRuntime.js";
import type { EnabledRuntimeReconciliationConfig } from "../src/reconciliation/runtimeReconciliationHost.js";

const config: EnabledRuntimeReconciliationConfig = {
  enabled: true,
  convexUrl: "https://example.convex.cloud",
  convexDeployment: "dev:example",
  serviceToken: "service-token",
  workerId: "worker-1",
  leaseMs: 30_000,
  intervalMs: 5_000,
  maxBatchSize: 10,
  maxAttempts: 5,
  baseRetryMs: 1_000,
  maxRetryMs: 60_000,
  freshnessMs: 60_000,
};

const outlookRuntime = {
  mailbox: "thebeeztreez@outlook.com",
  quoteEmailProvider: {
    name: "microsoft-graph-mail-v1",
    async prepare() {
      throw new Error("unused");
    },
    async sendPrepared() {
      throw new Error("unused");
    },
  },
  reconciliationAdapter: {
    provider: "microsoft-graph-mail-v1",
    async reconcile() {
      return { status: "unresolved", errorCode: "unused" } as const;
    },
  },
} satisfies MicrosoftOutlookRuntime;

describe("Outlook runtime reconciliation composition", () => {
  it("constructs no store without an enabled Outlook runtime", () => {
    let stores = 0;
    assert.equal(
      createOutlookRuntimeReconciliationFactories(null, {
        createStore() {
          stores += 1;
          throw new Error("Disabled composition must not create a store.");
        },
      }),
      undefined,
    );
    assert.equal(stores, 0);
  });

  it("runs the commissioned worker and scheduler with the Outlook adapter", async () => {
    const claims: Array<{ workerId: string; leaseMs: number }> = [];
    const store = {
      async claimNext(input: Parameters<ExternalReconciliationStore["claimNext"]>[0]) {
        claims.push({ workerId: input.workerId, leaseMs: input.leaseMs });
        return null;
      },
    } as unknown as ExternalReconciliationStore;
    const factories = createOutlookRuntimeReconciliationFactories(outlookRuntime, {
      createStore(received) {
        assert.deepEqual(received, config);
        return store;
      },
    });
    assert.ok(factories);

    const controller = new AbortController();
    const observations: string[] = [];
    const runtime = factories.createEnabledRuntime(config, (observation) => {
      observations.push(observation.type);
      if (observation.type === "completed") controller.abort();
    });
    await runtime.run(controller.signal);

    assert.deepEqual(claims, [{ workerId: "worker-1", leaseMs: 30_000 }]);
    assert.deepEqual(observations, ["started", "completed"]);
  });
});
