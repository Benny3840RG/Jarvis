import { ConvexHttpClient } from "convex/browser";

import type { MicrosoftOutlookRuntime } from "../auth/microsoftOutlookRuntime.js";
import {
  createGitHubDevelopmentClientFromEnv,
  GitHubMergeReconciliationAdapter,
  type GitHubDevelopmentClient,
} from "../development/githubDevelopment.js";
import { ConvexExternalReconciliationStore } from "../persistence/convexExternalReconciliations.js";
import type { ExternalReconciliationStore } from "./externalReconciliation.js";
import {
  ReconciliationScheduler,
  type ReconciliationCycleObservation,
} from "./reconciliationScheduler.js";
import { ReconciliationWorker } from "./reconciliationWorker.js";
import type {
  EnabledRuntimeReconciliationConfig,
  RuntimeReconciliationFactories,
} from "./runtimeReconciliationHost.js";

export type OutlookRuntimeReconciliationDependencies = {
  createStore?: (config: EnabledRuntimeReconciliationConfig) => ExternalReconciliationStore;
  observeCycle?: (observation: ReconciliationCycleObservation) => void;
  githubDevelopmentClient?: GitHubDevelopmentClient | null;
};

export function createOutlookRuntimeReconciliationFactories(
  outlookRuntime: MicrosoftOutlookRuntime | null,
  dependencies: OutlookRuntimeReconciliationDependencies = {},
): RuntimeReconciliationFactories | undefined {
  const githubDevelopmentClient =
    dependencies.githubDevelopmentClient === undefined
      ? createGitHubDevelopmentClientFromEnv()
      : dependencies.githubDevelopmentClient;
  if (outlookRuntime === null && githubDevelopmentClient === null) return undefined;

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
        adapters: [
          ...(outlookRuntime === null ? [] : [outlookRuntime.reconciliationAdapter]),
          ...(githubDevelopmentClient === null
            ? []
            : [new GitHubMergeReconciliationAdapter(githubDevelopmentClient)]),
        ],
        maxAttempts: config.maxAttempts,
        baseRetryMs: config.baseRetryMs,
        maxRetryMs: config.maxRetryMs,
      });
      return new ReconciliationScheduler(worker, {
        workerId: config.workerId,
        leaseMs: config.leaseMs,
        intervalMs: config.intervalMs,
        maxBatchSize: config.maxBatchSize,
        observeCycle: (observation) => {
          observeCycle(observation);
          dependencies.observeCycle?.(observation);
        },
      });
    },
  };
}
