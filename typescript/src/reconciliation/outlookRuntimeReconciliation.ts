import { ConvexHttpClient } from "convex/browser";

import type { MicrosoftOutlookRuntime } from "../auth/microsoftOutlookRuntime.js";
import type { SentryRuntime } from "../observability/sentry.js";
import { ConvexExternalReconciliationStore } from "../persistence/convexExternalReconciliations.js";
import type { ExternalReconciliationStore } from "./externalReconciliation.js";
import { ReconciliationScheduler } from "./reconciliationScheduler.js";
import { ReconciliationWorker } from "./reconciliationWorker.js";
import type {
  EnabledRuntimeReconciliationConfig,
  RuntimeReconciliationFactories,
} from "./runtimeReconciliationHost.js";

export type OutlookRuntimeReconciliationDependencies = {
  createStore?: (config: EnabledRuntimeReconciliationConfig) => ExternalReconciliationStore;
  observability?: SentryRuntime;
};

export function createOutlookRuntimeReconciliationFactories(
  outlookRuntime: MicrosoftOutlookRuntime | null,
  dependencies: OutlookRuntimeReconciliationDependencies = {},
): RuntimeReconciliationFactories | undefined {
  if (outlookRuntime === null) return undefined;

  return {
    createEnabledRuntime(config, observeCycle) {
      const store =
        dependencies.createStore?.(config) ??
        new ConvexExternalReconciliationStore(
          new ConvexHttpClient(config.convexUrl),
          config.serviceToken,
          config.convexDeployment,
        );
      const worker = new ReconciliationWorker({
        store,
        adapters: [outlookRuntime.reconciliationAdapter],
        maxAttempts: config.maxAttempts,
        baseRetryMs: config.baseRetryMs,
        maxRetryMs: config.maxRetryMs,
      });
      return new ReconciliationScheduler(worker, {
        workerId: config.workerId,
        leaseMs: config.leaseMs,
        intervalMs: config.intervalMs,
        maxBatchSize: config.maxBatchSize,
        observeCycle,
        observability: dependencies.observability,
      });
    },
  };
}
