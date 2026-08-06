import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { RuntimeEvent, RuntimeEventSink } from "../runtime/integrationCore.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const runtimeEventFunctions = api.runtimeEvents;

function boundedString(value: unknown, limit = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, limit) : undefined;
}

/**
 * Runtime events deliberately persist metadata, never the event payload. The
 * router payload is allowed to contain caller input, so this projection is
 * the storage boundary rather than a convenience formatter.
 */
function safeMetadata(event: RuntimeEvent): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const route = boundedString(event.payload.route);
  const errorCode = boundedString(event.payload.errorCode);
  const eventType = boundedString(event.payload.eventType);
  const eventSequence = event.payload.eventSequence;
  const failureCount = event.payload.failureCount;
  if (route !== undefined) metadata.route = route;
  if (errorCode !== undefined) metadata.errorCode = errorCode;
  if (eventType !== undefined) metadata.eventType = eventType;
  if (typeof eventSequence === "number" && Number.isInteger(eventSequence)) {
    metadata.eventSequence = eventSequence;
  }
  if (typeof failureCount === "number" && Number.isInteger(failureCount) && failureCount >= 1) {
    metadata.failureCount = failureCount;
  }
  return metadata;
}

export class ConvexRuntimeEventSink implements RuntimeEventSink {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
    if (!serviceToken) throw new Error("Runtime event persistence requires JARVIS_SERVICE_TOKEN.");
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Runtime event persistence requires CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async append(event: RuntimeEvent): Promise<void> {
    await this.client.mutation(runtimeEventFunctions.append, {
      serviceToken: this.serviceToken,
      eventId: event.id,
      sequence: event.sequence,
      eventType: event.type,
      correlationId: event.correlationId,
      ...(boundedString(event.payload.route) === undefined
        ? {}
        : { route: boundedString(event.payload.route) }),
      metadata: safeMetadata(event),
      occurredAt: new Date(event.occurredAt).getTime(),
    });
  }
}
