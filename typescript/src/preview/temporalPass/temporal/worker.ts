import { NativeConnection, Worker } from "@temporalio/worker";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeGovernedQuoteSend } from "./activities/governedQuoteSend.js";
import * as activities from "./activities/mockPassActivities.js";
import {
  describeWorkerVersion,
  formatWorkerVersionEvidence,
  resolveWorkerDeploymentOptions,
} from "./buildIdentity.js";
import { assertWorkerHoldsNoApprovalCredential } from "./workerAuthority.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TemporalPassWorkerOptions {
  taskQueue?: string;
  address?: string;
  namespace?: string;
}

export async function createPassWorker(options: TemporalPassWorkerOptions = {}): Promise<Worker> {
  const address = options.address ?? process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? "default";
  // Must match TemporalOrchestrator's default exactly — see the comment
  // there for why this can't be time-based.
  const taskQueue = options.taskQueue ?? process.env.TEMPORAL_TASK_QUEUE ?? "temporal-pass";

  // Immutable build identity (roadmap PR B). Off unless JARVIS_TEMPORAL_VERSIONING
  // is set, so the existing torture tests are unchanged; when set it fails closed
  // on a missing or mutable build SHA rather than registering an unversioned worker.
  const workerDeploymentOptions = resolveWorkerDeploymentOptions(process.env);

  // A versioned worker is the production posture (roadmap PR B, toward
  // AUTH-INV-04): it must hold no approval credential. Fail closed before
  // connecting. The unversioned torture-test path is unaffected.
  if (workerDeploymentOptions) {
    assertWorkerHoldsNoApprovalCredential(process.env);
  }

  // Make the registered version visible in evidence (roadmap PR-B gate): the
  // worker's stdout — which CI and the process harness already capture —
  // records the exact pinned version, or "unversioned".
  const versionEvidence = describeWorkerVersion(workerDeploymentOptions);
  console.log(`[temporal-pass] worker version: ${formatWorkerVersionEvidence(versionEvidence)}`);

  const connection = await NativeConnection.connect({ address });

  return Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: path.join(dirname, "workflows", "passWorkflow.ts"),
    activities: { ...activities, executeGovernedQuoteSend },
    ...(workerDeploymentOptions ? { workerDeploymentOptions } : {}),
  });
}
