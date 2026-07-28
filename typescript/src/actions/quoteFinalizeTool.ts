import { z } from "zod";

import type { QuoteRepository } from "../quotes/quoteRepository.js";
import type { ToolExecutionDefinition } from "./toolExecution.js";

export const QUOTE_FINALIZE_TOOL = "quotes";
export const QUOTE_FINALIZE_OPERATION = "finalize";

const quotePdfPartySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    abn: z.string().trim().min(1).max(40).optional(),
    email: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().min(1).max(60).optional(),
    addressLines: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
  })
  .strict();

export const quoteFinalizeArgumentsSchema = z
  .object({
    quoteId: z.string().trim().min(1).max(256),
    quoteRevision: z.number().int().min(1),
    expectedAggregateVersion: z.number().int().min(0),
    expectedRevisionVersion: z.number().int().min(0),
    issuer: quotePdfPartySchema,
    client: quotePdfPartySchema,
    generatedAt: z.string().datetime({ offset: false, precision: 3 }),
  })
  .strict();

export type QuoteFinalizeResult = {
  quoteId: string;
  revision: number;
  fingerprint: string;
};

/**
 * Internal-only `AM-012` finalisation boundary (`quotes:finalize`). Not
 * external — no reconciliation store dependency — so exact replay, changed-
 * content rejection, and idempotency-key scoping all come for free from
 * `ToolExecutionService`'s own receipt cache; this definition adds no second
 * receipt table. Preconditions (must be `reviewed`, versions must match) are
 * enforced once, inside `QuoteRepository.finalizeRevision` itself — this
 * tool never re-implements them, and never accepts a caller-supplied total
 * or fingerprint, since finalisation only ever recomputes and stamps the
 * fingerprint from the authoritative stored revision.
 */
export function createQuoteFinalizeToolDefinition(
  quotes: QuoteRepository,
): ToolExecutionDefinition {
  return {
    tool: QUOTE_FINALIZE_TOOL,
    operation: QUOTE_FINALIZE_OPERATION,
    schema: quoteFinalizeArgumentsSchema,
    async execute(argumentsValue): Promise<QuoteFinalizeResult> {
      const parsed = quoteFinalizeArgumentsSchema.parse(argumentsValue);
      const snapshot = await quotes.finalizeRevision({
        quoteId: parsed.quoteId,
        revision: parsed.quoteRevision,
        expectedAggregateVersion: parsed.expectedAggregateVersion,
        expectedRevisionVersion: parsed.expectedRevisionVersion,
        issuer: parsed.issuer,
        client: parsed.client,
        generatedAt: parsed.generatedAt,
      });
      if (!snapshot.revision.fingerprint) {
        throw new Error(
          `Quote ${parsed.quoteId} revision ${parsed.quoteRevision} finalized without a fingerprint.`,
        );
      }
      return {
        quoteId: parsed.quoteId,
        revision: parsed.quoteRevision,
        fingerprint: snapshot.revision.fingerprint,
      };
    },
  };
}
