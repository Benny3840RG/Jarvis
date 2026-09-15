import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { mutation, type MutationCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";

const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_SOURCE_URL_LENGTH = 2048;

function cleanRequired(value: string, label: string, maxLength = 200): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} is required.`);
  if (cleaned.length > maxLength) throw new Error(`${label} exceeds the maximum length.`);
  return cleaned;
}

/**
 * Durable, service-token-gated record of a genuine verification/review
 * outcome, bound to the exact head SHA it was observed against.
 *
 * This does not make the record cryptographically unforgeable -- a
 * serviceToken holder can call this the same way it could previously supply
 * a fabricated inline evidence claim to developmentState.commit. What it
 * achieves, matching this codebase's existing security posture for the
 * merge path (developmentState.ts's trustedMergeReason): forging evidence
 * now requires going through a properly-modeled, subject/head-bound record
 * in a real table -- creating an audit trail and requiring the fabrication
 * to stay consistent with the mission's actual current head -- rather than
 * freely asserting an arbitrary boolean in a single call with zero
 * cross-referencing. Hardening *this* mutation's own trust boundary (e.g.
 * restricting it to a specific trusted CI identity) is future work.
 */
export const recordDevelopmentEvidence = mutation({
  args: {
    serviceToken: v.string(),
    subjectId: v.string(),
    kind: v.union(v.literal("verification"), v.literal("review")),
    headSha: v.string(),
    outcome: v.union(v.literal("clean"), v.literal("blocking")),
    sourceUrl: v.string(),
  },
  returns: v.object({
    subjectId: v.string(),
    kind: v.union(v.literal("verification"), v.literal("review")),
    headSha: v.string(),
    outcome: v.union(v.literal("clean"), v.literal("blocking")),
    recordedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const subjectId = cleanRequired(args.subjectId, "Development subject ID");
    const headSha = args.headSha.trim().toLowerCase();
    if (!HEAD_SHA_PATTERN.test(headSha)) {
      throw new Error("headSha must be an exact 40-character hex commit SHA.");
    }
    const sourceUrl = cleanRequired(args.sourceUrl, "Evidence source URL", MAX_SOURCE_URL_LENGTH);

    const subject = await ctx.db
      .query("developmentSubjects")
      .withIndex("by_owner_and_subject_id", (q) =>
        q.eq("ownerId", ownerId).eq("subjectId", subjectId),
      )
      .unique();
    if (!subject) throw new Error("Development subject does not exist.");

    const recordedAt = Date.now();
    await ctx.db.insert("developmentEvidence", {
      ownerId,
      subjectId,
      kind: args.kind,
      headSha,
      outcome: args.outcome,
      sourceUrl,
      recordedAt,
      createdAt: recordedAt,
    });

    return { subjectId, kind: args.kind, headSha, outcome: args.outcome, recordedAt };
  },
});

/**
 * The latest recorded evidence for (subjectId, kind, headSha), or undefined
 * if none exists. Bounded to the most recent 32 records for this exact
 * binding -- there should almost always be at most one, but a retried
 * caller could legitimately write more than one for the same head.
 */
export async function findLatestDevelopmentEvidence(
  ctx: MutationCtx,
  ownerId: string,
  subjectId: string,
  kind: "verification" | "review",
  headSha: string,
): Promise<Doc<"developmentEvidence"> | undefined> {
  const candidates = await ctx.db
    .query("developmentEvidence")
    .withIndex("by_owner_subject_kind_and_head", (q) =>
      q
        .eq("ownerId", ownerId)
        .eq("subjectId", subjectId)
        .eq("kind", kind)
        .eq("headSha", headSha.toLowerCase()),
    )
    .order("desc")
    .take(32);
  return candidates[0];
}
