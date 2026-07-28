import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  quotePdfArtifactDocumentValidator,
  quotePdfArtifactPublicValidator,
  quotePdfArtifactRetrievalValidator,
  quotePdfPartyValidator,
} from "./quotePdfArtifactValidators.js";
import { finalizeQuoteRevision, quoteSnapshotDocumentValidator } from "./quoteValidators.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";

const finalizationArgs = {
  serviceToken: v.string(),
  quoteId: v.string(),
  revision: v.number(),
  expectedAggregateVersion: v.number(),
  expectedRevisionVersion: v.number(),
  finalizedAt: v.number(),
};

const artifactCommitArgs = {
  ...finalizationArgs,
  expectedRevisionFingerprint: v.string(),
  storageId: v.id("_storage"),
  digest: v.string(),
  byteLength: v.number(),
  mediaType: v.literal("application/pdf"),
  filename: v.string(),
  rendererVersion: v.literal("quote-pdf:v1"),
  generatedAt: v.string(),
  issuer: quotePdfPartyValidator,
  client: quotePdfPartyValidator,
};

function cleanRequiredText(value: string, code: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(code);
  return cleaned;
}

function validatedRevision(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error("quote-revision-invalid");
  return value;
}

async function findSnapshot(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  quoteId: string,
  revision: number,
): Promise<{ aggregate: Doc<"quotes">; revision: Doc<"quoteRevisions"> }> {
  const aggregate = await ctx.db
    .query("quotes")
    .withIndex("by_owner_and_quote_id", (q) => q.eq("ownerId", ownerId).eq("quoteId", quoteId))
    .unique();
  const quoteRevision = await ctx.db
    .query("quoteRevisions")
    .withIndex("by_owner_quote_and_revision", (q) =>
      q.eq("ownerId", ownerId).eq("quoteId", quoteId).eq("revision", revision),
    )
    .unique();
  if (!aggregate || !quoteRevision) throw new Error("Quote not found.");
  return { aggregate, revision: quoteRevision };
}

function publicArtifact(artifact: Doc<"quotePdfArtifacts">) {
  return {
    quoteId: artifact.quoteId,
    revisionId: artifact.revisionId,
    revision: artifact.revision,
    revisionFingerprint: artifact.revisionFingerprint,
    digest: artifact.digest,
    byteLength: artifact.byteLength,
    mediaType: artifact.mediaType,
    filename: artifact.filename,
    rendererVersion: artifact.rendererVersion,
    generatedAt: artifact.generatedAt,
    issuer: artifact.issuer,
    client: artifact.client,
    createdAt: artifact.createdAt,
  };
}

export const prepareFinalization = internalQuery({
  args: finalizationArgs,
  returns: quoteSnapshotDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const current = await findSnapshot(
      ctx,
      ownerId,
      cleanRequiredText(args.quoteId, "quote-id-invalid"),
      validatedRevision(args.revision),
    );
    const replacement = await finalizeQuoteRevision({
      aggregate: current.aggregate,
      revision: current.revision,
      expectedAggregateVersion: args.expectedAggregateVersion,
      expectedRevisionVersion: args.expectedRevisionVersion,
      now: args.finalizedAt,
    });
    return {
      aggregate: {
        ...replacement.aggregate,
        _id: current.aggregate._id,
        _creationTime: current.aggregate._creationTime,
      },
      revision: {
        ...replacement.revision,
        _id: current.revision._id,
        _creationTime: current.revision._creationTime,
      },
    };
  },
});

export const commitFinalization = internalMutation({
  args: artifactCommitArgs,
  returns: v.object({
    snapshot: quoteSnapshotDocumentValidator,
    artifact: quotePdfArtifactDocumentValidator,
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const quoteId = cleanRequiredText(args.quoteId, "quote-id-invalid");
    const revisionNumber = validatedRevision(args.revision);
    const current = await findSnapshot(ctx, ownerId, quoteId, revisionNumber);
    const replacement = await finalizeQuoteRevision({
      aggregate: current.aggregate,
      revision: current.revision,
      expectedAggregateVersion: args.expectedAggregateVersion,
      expectedRevisionVersion: args.expectedRevisionVersion,
      now: args.finalizedAt,
    });
    if (replacement.revision.fingerprint !== args.expectedRevisionFingerprint) {
      throw new Error("quote-pdf-fingerprint-mismatch");
    }

    const existing = await ctx.db
      .query("quotePdfArtifacts")
      .withIndex("by_owner_quote_and_revision", (q) =>
        q.eq("ownerId", ownerId).eq("quoteId", quoteId).eq("revision", revisionNumber),
      )
      .unique();
    if (existing) throw new Error("quote-pdf-artifact-exists");

    const storageMetadata = await ctx.db.system.get("_storage", args.storageId);
    if (
      !storageMetadata ||
      storageMetadata.size !== args.byteLength ||
      (storageMetadata.contentType !== undefined && storageMetadata.contentType !== args.mediaType)
    ) {
      throw new Error("quote-pdf-storage-invalid");
    }

    await ctx.db.replace("quotes", current.aggregate._id, replacement.aggregate);
    await ctx.db.replace("quoteRevisions", current.revision._id, replacement.revision);
    const artifactId = await ctx.db.insert("quotePdfArtifacts", {
      ownerId,
      quoteId,
      revisionId: replacement.revision.revisionId,
      revision: revisionNumber,
      revisionFingerprint: args.expectedRevisionFingerprint,
      storageId: args.storageId,
      digest: cleanRequiredText(args.digest, "quote-pdf-digest-invalid"),
      byteLength: args.byteLength,
      mediaType: args.mediaType,
      filename: cleanRequiredText(args.filename, "quote-pdf-filename-invalid"),
      rendererVersion: args.rendererVersion,
      generatedAt: args.generatedAt,
      issuer: args.issuer,
      client: args.client,
      createdAt: args.finalizedAt,
    });

    const aggregate = await ctx.db.get("quotes", current.aggregate._id);
    const revision = await ctx.db.get("quoteRevisions", current.revision._id);
    const artifact = await ctx.db.get("quotePdfArtifacts", artifactId);
    if (!aggregate || !revision || !artifact) throw new Error("quote-pdf-commit-failed");
    return { snapshot: { aggregate, revision }, artifact };
  },
});

export const getForRevision = query({
  args: { serviceToken: v.string(), quoteId: v.string(), revision: v.number() },
  returns: v.union(quotePdfArtifactRetrievalValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const artifact = await ctx.db
      .query("quotePdfArtifacts")
      .withIndex("by_owner_quote_and_revision", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("quoteId", cleanRequiredText(args.quoteId, "quote-id-invalid"))
          .eq("revision", validatedRevision(args.revision)),
      )
      .unique();
    if (!artifact) return null;
    const url = await ctx.storage.getUrl(artifact.storageId);
    if (!url) throw new Error("quote-pdf-storage-missing");
    return { ...publicArtifact(artifact), url };
  },
});

export { publicArtifact, quotePdfArtifactPublicValidator };
