import { v } from "convex/values";

import { quoteSnapshotDocumentValidator } from "./quoteValidators.js";

export const quotePdfPartyValidator = v.object({
  name: v.string(),
  abn: v.optional(v.string()),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  addressLines: v.optional(v.array(v.string())),
});

export const quotePdfArtifactDocumentValidator = v.object({
  _id: v.id("quotePdfArtifacts"),
  _creationTime: v.number(),
  ownerId: v.string(),
  quoteId: v.string(),
  revisionId: v.string(),
  revision: v.number(),
  revisionFingerprint: v.string(),
  storageId: v.id("_storage"),
  digest: v.string(),
  byteLength: v.number(),
  mediaType: v.literal("application/pdf"),
  filename: v.string(),
  rendererVersion: v.literal("quote-pdf:v1"),
  generatedAt: v.string(),
  issuer: quotePdfPartyValidator,
  client: quotePdfPartyValidator,
  createdAt: v.number(),
});

export const quotePdfArtifactPublicValidator = v.object({
  quoteId: v.string(),
  revisionId: v.string(),
  revision: v.number(),
  revisionFingerprint: v.string(),
  digest: v.string(),
  byteLength: v.number(),
  mediaType: v.literal("application/pdf"),
  filename: v.string(),
  rendererVersion: v.literal("quote-pdf:v1"),
  generatedAt: v.string(),
  issuer: quotePdfPartyValidator,
  client: quotePdfPartyValidator,
  createdAt: v.number(),
});

export const quotePdfArtifactRetrievalValidator = v.object({
  ...quotePdfArtifactPublicValidator.fields,
  url: v.string(),
});

export const quoteFinalizationResultValidator = v.object({
  snapshot: quoteSnapshotDocumentValidator,
  artifact: quotePdfArtifactPublicValidator,
});
