import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type {
  CancelControlledReminderInput,
  ControlledReminderRecord,
  ControlledReminderStore,
  CreateControlledReminderInput,
} from "../reminders/controlledReminder.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const controlledReminderFunctions = api.reminders;

type ControlledReminderRow = {
  kind: "reminder";
  id: string;
  projectId: string;
  title: string;
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  cancelledAt?: number;
};

function reminderFromConvex(row: ControlledReminderRow): ControlledReminderRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    ...(row.dueRaw === undefined ? {} : { dueRaw: row.dueRaw }),
    ...(row.dueAt === undefined ? {} : { dueAt: row.dueAt }),
    ...(row.dueTimezone === undefined ? {} : { dueTimezone: row.dueTimezone }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
    ...(row.cancelledAt === undefined ? {} : { cancelledAt: row.cancelledAt }),
  };
}

export class ConvexControlledReminderStore implements ControlledReminderStore {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) throw new Error("Controlled reminders require JARVIS_SERVICE_TOKEN.");
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Controlled reminders require CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async create(input: CreateControlledReminderInput): Promise<ControlledReminderRecord> {
    const row = await this.client.mutation(controlledReminderFunctions.createControlled, {
      serviceToken: this.serviceToken,
      projectId: input.projectId,
      title: input.title,
      ...(input.dueRaw === undefined ? {} : { dueRaw: input.dueRaw }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.dueTimezone === undefined ? {} : { dueTimezone: input.dueTimezone }),
      idempotencyKey: input.idempotencyKey,
      actionFingerprint: input.actionFingerprint,
      sourceRequestId: input.sourceRequestId,
      correlationId: input.correlationId,
      source: input.source,
    });
    return reminderFromConvex(row as ControlledReminderRow);
  }

  async cancel(input: CancelControlledReminderInput): Promise<ControlledReminderRecord | null> {
    const row = await this.client.mutation(controlledReminderFunctions.cancelControlled, {
      serviceToken: this.serviceToken,
      projectId: input.projectId,
      id: input.reminderId,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint: input.actionFingerprint,
      sourceRequestId: input.sourceRequestId,
      correlationId: input.correlationId,
      source: input.source,
    });
    return row === null ? null : reminderFromConvex(row as ControlledReminderRow);
  }

  async get(projectId: string, reminderId: string): Promise<ControlledReminderRecord | null> {
    const row = await this.client.query(controlledReminderFunctions.getControlled, {
      serviceToken: this.serviceToken,
      projectId,
      id: reminderId,
    });
    return row === null ? null : reminderFromConvex(row as ControlledReminderRow);
  }

  async cleanup(projectId: string, reminderId: string): Promise<boolean> {
    return this.client.mutation(controlledReminderFunctions.cleanupControlled, {
      serviceToken: this.serviceToken,
      projectId,
      id: reminderId,
    });
  }
}
