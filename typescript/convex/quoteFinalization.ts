"use node";

import { v } from "convex/values";

import { renderFinalizedQuotePdf } from "../src/quotes/quotePdfRenderer.js";
import { internal } from "./_generated/api.js";
import { action } from "./_generated/server.js";
import {
  quoteFinalizationResultValidator,
  quotePdfPartyValidator,
} from "./quotePdfArtifactValidators.js";

function canonicalTimestamp(value: string): { iso: string; milliseconds: number } {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("quote-pdf-generated-at-invalid");
  }
  return { iso: value, milliseconds };
}

export const finalizeRevision = action({
  args: {
    serviceToken: v.string(),
    quoteId: v.string(),
    revision: v.number(),
    expectedAggregateVersion: v.number(),
    expectedRevisionVersion: v.number(),
    issuer: quotePdfPartyValidator,
    client: quotePdfPartyValidator,
    generatedAt: v.string(),
  },
  returns: quoteFinalizationResultValidator,
  handler: async (ctx, args) => {
    const generated = canonicalTimestamp(args.generatedAt);
    const finalizationArgs = {
      serviceToken: args.serviceToken,
      quoteId: args.quoteId,
      revision: args.revision,
      expectedAggregateVersion: args.expectedAggregateVersion,
      expectedRevisionVersion: args.expectedRevisionVersion,
      finalizedAt: generated.milliseconds,
    };
    const snapshot = await ctx.runQuery(
      internal.quotePdfArtifacts.prepareFinalization,
      finalizationArgs,
    );
    const rendered = renderFinalizedQuotePdf({
      snapshot,
      issuer: args.issuer,
      client: args.client,
      generatedAt: generated.iso,
    });
    const exactBytes = rendered.bytes.slice();
    const storageId = await ctx.storage.store(
      new Blob([exactBytes.buffer as ArrayBuffer], { type: rendered.mediaType }),
    );

    try {
      const committed = await ctx.runMutation(internal.quotePdfArtifacts.commitFinalization, {
        ...finalizationArgs,
        expectedRevisionFingerprint: snapshot.revision.fingerprint!,
        storageId,
        digest: rendered.digest,
        byteLength: rendered.byteLength,
        mediaType: rendered.mediaType,
        filename: rendered.filename,
        rendererVersion: "quote-pdf:v1",
        generatedAt: generated.iso,
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
