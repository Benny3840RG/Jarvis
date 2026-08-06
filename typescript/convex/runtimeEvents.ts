import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { normaliseAuditPayload } from "./toolActionLogic.js";
import { runtimeEventDocumentValidator } from "./runtimeEventValidators.js";
import { mutation, query } from "./_generated/server.js";

const runtimeEventInputValidator = {
  serviceToken: v.string(),
  eventId: v.string(),
  sequence: v.number(),
  eventType: v.string(),
  correlationId: v.string(),
  route: v.optional(v.string()),
  metadata: v.record(v.string(), v.any()),
  occurredAt: v.number(),
};

function cleanRequired(value: string, label: string, maxLength = 200): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} cannot be empty.`);
  if (cleaned.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
  return cleaned;
}

function sameEvent(
  existing: {
    sequence: number;
    eventType: string;
    correlationId: string;
    route?: string;
    metadata: Record<string, unknown>;
    occurredAt: number;
  },
  incoming: {
    sequence: number;
    eventType: string;
    correlationId: string;
    route?: string;
    metadata: Record<string, unknown>;
    occurredAt: number;
  },
): boolean {
  return (
    existing.sequence === incoming.sequence &&
    existing.eventType === incoming.eventType &&
    existing.correlationId === incoming.correlationId &&
    existing.route === incoming.route &&
    existing.occurredAt === incoming.occurredAt &&
    JSON.stringify(existing.metadata) === JSON.stringify(incoming.metadata)
  );
}

export const append = mutation({
  args: runtimeEventInputValidator,
  returns: runtimeEventDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const eventId = cleanRequired(args.eventId, "Runtime event ID");
    const eventType = cleanRequired(args.eventType, "Runtime event type");
    const correlationId = cleanRequired(args.correlationId, "Runtime correlation ID");
    const route = args.route === undefined ? undefined : cleanRequired(args.route, "Runtime route");
    const metadata = normaliseAuditPayload(args.metadata);
    if (!Number.isInteger(args.sequence) || args.sequence < 1) {
      throw new Error("Runtime event sequence must be a positive integer.");
    }
    if (!Number.isFinite(args.occurredAt) || args.occurredAt < 0) {
      throw new Error("Runtime event timestamp must be a finite non-negative number.");
    }

    const incoming = {
      sequence: args.sequence,
      eventType,
      correlationId,
      ...(route ? { route } : {}),
      metadata,
      occurredAt: args.occurredAt,
    };
    const existing = await ctx.db
      .query("runtimeEvents")
      .withIndex("by_owner_and_event_id", (q) => q.eq("ownerId", ownerId).eq("eventId", eventId))
      .unique();
    if (existing) {
      if (!sameEvent(existing, incoming)) {
        throw new Error("Runtime event ID collision.");
      }
      return existing;
    }

    const now = Date.now();
    const id = await ctx.db.insert("runtimeEvents", {
      ownerId,
      eventId,
      ...incoming,
      createdAt: now,
    });
    const created = await ctx.db.get("runtimeEvents", id);
    if (!created) throw new Error("Runtime event creation failed.");
    return created;
  },
});

export const listPage = query({
  args: {
    serviceToken: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(runtimeEventDocumentValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("runtimeEvents")
      .withIndex("by_owner_and_created_at", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
