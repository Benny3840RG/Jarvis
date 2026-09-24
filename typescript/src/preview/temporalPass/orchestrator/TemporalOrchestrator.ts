import { Client, Connection } from "@temporalio/client";

import type { ApprovalResponse, MissionIntent, MissionState } from "../types.js";
import {
  bennyApprovalSignal,
  getMissionStateQuery,
  passWorkflow,
} from "../temporal/workflows/passWorkflow.js";
import type { JarvisOrchestrator } from "./JarvisOrchestrator.js";

export interface TemporalOrchestratorOptions {
  address?: string;
  namespace?: string;
  taskQueue?: string;
}

export class TemporalOrchestrator implements JarvisOrchestrator {
  private readonly taskQueue: string;
  private readonly connectionPromise: Promise<Connection>;
  private clientPromise: Promise<Client> | undefined;

  constructor(options: TemporalOrchestratorOptions = {}) {
    const address = options.address ?? process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
    const namespace = options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? "default";
    // A time-based default (e.g. `temporal-pass-${Date.now()}`) would make an
    // orchestrator and a worker started separately — the normal case outside
    // tests, which always pass an explicit taskQueue — silently disagree on
    // the queue name, since each side's Date.now() call resolves at a
    // different millisecond. A fixed, stable default lets both sides agree
    // out of the box; TEMPORAL_TASK_QUEUE is still there for anyone who
    // needs real isolation (e.g. multiple environments sharing one server).
    this.taskQueue = options.taskQueue ?? process.env.TEMPORAL_TASK_QUEUE ?? "temporal-pass";

    this.connectionPromise = Connection.connect({ address });
    this.clientPromise = this.connectionPromise.then(
      (connection) => new Client({ connection, namespace }),
    );
  }

  private async client(): Promise<Client> {
    if (!this.clientPromise) throw new Error("TemporalOrchestrator has been shut down");
    return this.clientPromise;
  }

  async startMission(intent: MissionIntent): Promise<{ missionId: string }> {
    const client = await this.client();
    await client.workflow.start(passWorkflow, {
      taskQueue: this.taskQueue,
      workflowId: intent.id,
      args: [intent],
    });
    return { missionId: intent.id };
  }

  async getMissionState(missionId: string): Promise<MissionState> {
    const client = await this.client();
    const handle = client.workflow.getHandle(missionId);
    return handle.query(getMissionStateQuery);
  }

  async sendApproval(missionId: string, approval: ApprovalResponse): Promise<void> {
    const client = await this.client();
    const handle = client.workflow.getHandle(missionId);
    await handle.signal(bennyApprovalSignal, approval);
  }

  async shutdown(): Promise<void> {
    const connection = await this.connectionPromise;
    await connection.close();
    this.clientPromise = undefined;
  }
}
