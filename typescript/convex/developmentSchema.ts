import { defineTable } from "convex/server";
import { v } from "convex/values";

import {
  developmentActorRefValidator,
  developmentEventTypeValidator,
  developmentStateValidator,
} from "./developmentValidators.js";

export const developmentTables = {
  developmentSubjects: defineTable({
    ownerId: v.string(),
    subjectId: v.string(),
    state: developmentStateValidator,
    subjectVersion: v.number(),
    projectionVersion: v.number(),
    reducerVersion: v.string(),
    lastEventId: v.optional(v.string()),
    fencingToken: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner_and_subject_id", ["ownerId", "subjectId"]),
  developmentEvents: defineTable({
    ownerId: v.string(),
    subjectId: v.string(),
    eventId: v.string(),
    eventType: developmentEventTypeValidator,
    eventSchemaVersion: v.number(),
    transitionId: v.optional(v.string()),
    requestedBy: v.optional(developmentActorRefValidator),
    evaluatedBy: v.optional(developmentActorRefValidator),
    authorisedBy: v.optional(developmentActorRefValidator),
    committedBy: v.optional(developmentActorRefValidator),
    occurredAt: v.string(),
    recordedAt: v.string(),
    evidenceIds: v.array(v.string()),
    correlationId: v.string(),
    causationId: v.optional(v.string()),
    reducerVersion: v.string(),
    payload: v.record(v.string(), v.any()),
    createdAt: v.number(),
  })
    .index("by_owner_and_subject_id_and_event_id", ["ownerId", "subjectId", "eventId"])
    .index("by_owner_and_subject_id_and_created_at", ["ownerId", "subjectId", "createdAt"]),
};
