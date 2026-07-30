import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type {
  ActivityActor,
  ActivityEventReader,
  RawActivityEvent,
} from "../operations/activityTimeline.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const auditEventFunctions = api.auditEvents;

const GLOBAL_SCOPE = "__global__";

type AuditEventRow = {
  _id: string;
  scopeKey: string;
  eventType: string;
  actor: ActivityActor;
  payload: Record<string, unknown>;
  createdAt: number;
};

function rawEventFromConvex(row: AuditEventRow): RawActivityEvent {
  return {
    activityId: row._id,
    eventType: row.eventType,
    actor: row.actor,
    payload: row.payload,
    createdAt: row.createdAt,
    ...(row.scopeKey === GLOBAL_SCOPE ? {} : { projectKey: row.scopeKey }),
  };
}

export class ConvexActivityEventReader implements ActivityEventReader {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) throw new Error("Activity timeline requires JARVIS_SERVICE_TOKEN.");
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Activity timeline requires CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async listActivityPage(
    input: Parameters<ActivityEventReader["listActivityPage"]>[0],
  ): ReturnType<ActivityEventReader["listActivityPage"]> {
    const result = await this.client.query(auditEventFunctions.listActivityPage, {
      serviceToken: this.serviceToken,
      paginationOpts: { cursor: input.cursor, numItems: input.limit },
    });
    const { page, continueCursor, isDone } = result as {
      page: AuditEventRow[];
      continueCursor: string;
      isDone: boolean;
    };
    return { events: page.map(rawEventFromConvex), continueCursor, isDone };
  }
}
