import { z } from "zod";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** Shared pure validation for the existing governed GitHub merge action. */
export const githubMergeArguments = z.object({
  subjectId: z.string().trim().min(1).max(200),
  transitionId: z.literal("DEV_TRANSITION_READY_TO_MERGE_TO_MERGED"),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pullRequestNumber: z.number().int().positive(),
  baseBranch: z.string().trim().min(1).max(200),
  reviewedHeadSha: z.string().regex(SHA_PATTERN),
  reviewedBaseSha: z.string().regex(SHA_PATTERN).optional(),
  candidateEvidenceFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]),
  authorityEnvelopeHash: z.string().trim().min(1),
  policyDecisionFingerprint: z.string().trim().min(1),
  effectiveRisk: z.number().int().min(4),
});
