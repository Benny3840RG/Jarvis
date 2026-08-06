import { v } from "convex/values";

export const runtimeEventDocumentValidator = v.object({
  _id: v.id("runtimeEvents"),
  _creationTime: v.number(),
  ownerId: v.string(),
  eventId: v.string(),
  sequence: v.number(),
  eventType: v.string(),
  correlationId: v.string(),
  route: v.optional(v.string()),
  metadata: v.record(v.string(), v.any()),
  occurredAt: v.number(),
  createdAt: v.number(),
});
