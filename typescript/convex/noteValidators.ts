import { v } from "convex/values";

export const noteDomainValidator = v.union(
  v.literal("business"),
  v.literal("home"),
  v.literal("workshop"),
  v.literal("shared"),
);

export const noteSensitivityValidator = v.union(
  v.literal("internal"),
  v.literal("private"),
  v.literal("secret"),
);

export const noteRetentionValidator = v.union(
  v.literal("ephemeral"),
  v.literal("standard"),
  v.literal("long_term"),
);

export const noteDocumentValidator = v.object({
  _id: v.id("notes"),
  _creationTime: v.number(),
  ownerId: v.string(),
  projectId: v.string(),
  title: v.string(),
  body: v.string(),
  tags: v.array(v.string()),
  domain: noteDomainValidator,
  sensitivity: noteSensitivityValidator,
  retention: noteRetentionValidator,
  idempotencyKey: v.string(),
  actionFingerprint: v.string(),
  sourceRequestId: v.string(),
  correlationId: v.string(),
  source: v.string(),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
