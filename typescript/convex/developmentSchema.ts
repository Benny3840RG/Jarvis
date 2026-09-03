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
    // Existing deployments may contain pre-binding rows. Consequential
    // transitions fail closed until all four immutable mission bindings are
    // present; every newly-created subject writes them atomically.
    orchestrationRunId: v.optional(v.string()),
    orchestrationNodeId: v.optional(v.string()),
    omegaMissionId: v.optional(v.string()),
    repository: v.optional(v.string()),
    branch: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_and_subject_id", ["ownerId", "subjectId"])
    .index("by_owner_and_updated_at", ["ownerId", "updatedAt"]),
  developmentEvents: defineTable({
    ownerId: v.string(),
    subjectId: v.string(),
    eventId: v.string(),
    requestId: v.string(),
    canonicalRequestFingerprint: v.string(),
    canonicalEventFingerprint: v.string(),
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
    .index("by_owner_and_subject_id_and_request_id", ["ownerId", "subjectId", "requestId"])
    .index("by_owner_and_subject_id_and_created_at", ["ownerId", "subjectId", "createdAt"]),
};
