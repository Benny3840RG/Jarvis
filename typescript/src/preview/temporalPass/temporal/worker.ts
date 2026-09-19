import { NativeConnection, Worker } from "@temporalio/worker";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as activities from "./activities/mockPassActivities.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TemporalPassWorkerOptions {
  taskQueue?: string;
  address?: string;
  namespace?: string;
}

export async function createPassWorker(options: TemporalPassWorkerOptions = {}): Promise<Worker> {
  const address = options.address ?? process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? "default";
  const taskQueue =
    options.taskQueue ?? process.env.TEMPORAL_TASK_QUEUE ?? `temporal-pass-${Date.now()}`;

  const connection = await NativeConnection.connect({ address });

  return Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: path.join(dirname, "workflows", "passWorkflow.ts"),
    activities,
  });
}
