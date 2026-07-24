import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type {
  CompleteControlledTaskInput,
  ControlledTaskRecord,
  ControlledTaskStore,
  CreateControlledTaskInput,
} from "../tasks/controlledTask.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const controlledTaskFunctions = api.tasks;

type ControlledTaskRow = {
  kind: "task";
  id: string;
  projectId: string;
  title: string;
  category: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
  completedAt?: number;
};

function taskFromConvex(row: ControlledTaskRow): ControlledTaskRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    category: row.category,
    completed: row.completed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
    ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
  };
}

export class ConvexControlledTaskStore implements ControlledTaskStore {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) throw new Error("Controlled tasks require JARVIS_SERVICE_TOKEN.");
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Controlled tasks require CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async create(input: CreateControlledTaskInput): Promise<ControlledTaskRecord> {
    const row = await this.client.mutation(controlledTaskFunctions.createControlled, {
      serviceToken: this.serviceToken,
      projectId: input.projectId,
      title: input.title,
      category: input.category,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint: input.actionFingerprint,
      sourceRequestId: input.sourceRequestId,
      correlationId: input.correlationId,
      source: input.source,
    });
    return taskFromConvex(row as ControlledTaskRow);
  }

  async complete(input: CompleteControlledTaskInput): Promise<ControlledTaskRecord | null> {
    const row = await this.client.mutation(controlledTaskFunctions.completeControlled, {
      serviceToken: this.serviceToken,
      projectId: input.projectId,
      id: input.taskId,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint: input.actionFingerprint,
      sourceRequestId: input.sourceRequestId,
      correlationId: input.correlationId,
      source: input.source,
    });
    return row === null ? null : taskFromConvex(row as ControlledTaskRow);
  }

  async get(projectId: string, taskId: string): Promise<ControlledTaskRecord | null> {
    const row = await this.client.query(controlledTaskFunctions.getControlled, {
      serviceToken: this.serviceToken,
      projectId,
      id: taskId,
    });
    return row === null ? null : taskFromConvex(row as ControlledTaskRow);
  }

  async cleanup(projectId: string, taskId: string): Promise<boolean> {
    return this.client.mutation(controlledTaskFunctions.cleanupControlled, {
      serviceToken: this.serviceToken,
      projectId,
      id: taskId,
    });
  }
}
