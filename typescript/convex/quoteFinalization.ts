"use node";

import { v } from "convex/values";

import { renderFinalizedQuotePdf } from "../src/quotes/quotePdfRenderer.js";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { action } from "./_generated/server.js";
import {
  quoteFinalizationResultValidator,
  quotePdfPartyValidator,
} from "./quotePdfArtifactValidators.js";

type SnapshotDoc = {
  aggregate: Doc<"quotes">;
  revision: Doc<"quoteRevisions">;
};

type PublicArtifact = Omit<
  Doc<"quotePdfArtifacts">,
  "_id" | "_creationTime" | "ownerId" | "storageId"
>;

type FinalizationResult = {
  snapshot: SnapshotDoc;
  artifact: PublicArtifact;
};

export const finalizeRevision = action({
  args: {
    serviceToken: v.string(),
    quoteId: v.string(),
    revision: v.number(),
    expectedAggregateVersion: v.number(),
    expectedRevisionVersion: v.number(),
    issuer: quotePdfPartyValidator,
    client: quotePdfPartyValidator,
  },
  returns: quoteFinalizationResultValidator,
  handler: async (ctx, args): Promise<FinalizationResult> => {
    const finalizedAt = Date.now();
    const generatedAt = new Date(finalizedAt).toISOString();
    const finalizationArgs = {
      serviceToken: args.serviceToken,
      quoteId: args.quoteId,
      revision: args.revision,
      expectedAggregateVersion: args.expectedAggregateVersion,
      expectedRevisionVersion: args.expectedRevisionVersion,
      finalizedAt,
    };
    const snapshot: SnapshotDoc = await ctx.runQuery(
      internal.quotePdfArtifacts.prepareFinalization,
      finalizationArgs,
    );
    const rendered = renderFinalizedQuotePdf({
      snapshot,
      issuer: args.issuer,
      client: args.client,
      generatedAt,
    });
    const exactBytes = rendered.bytes.slice();
    const storageId = await ctx.storage.store(
      new Blob([exactBytes.buffer as ArrayBuffer], { type: rendered.mediaType }),
    );

    try {
      const committed: { snapshot: SnapshotDoc; artifact: Doc<"quotePdfArtifacts"> } = await ctx.runMutation(internal.quotePdfArtifacts.commitFinalization, {
        ...finalizationArgs,
        expectedRevisionFingerprint: snapshot.revision.fingerprint!,
        storageId,
        digest: rendered.digest,
        byteLength: rendered.byteLength,
        mediaType: rendered.mediaType,
        filename: rendered.filename,
        rendererVersion: "quote-pdf:v1",
        generatedAt,
        issuer: args.issuer,
        client: args.client,
      });
      const artifact = committed.artifact;
      return {
        snapshot: committed.snapshot,
        artifact: {
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
        },
      };
    } catch (error: unknown) {
      try {
        await ctx.storage.delete(storageId);
      } catch {
        // Preserve the authoritative finalisation failure. Unreferenced storage
        // objects are safe and can be swept operationally.
      }
      throw error;
    }
  },
});
