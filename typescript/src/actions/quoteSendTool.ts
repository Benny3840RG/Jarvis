import { z } from "zod";

import type { QuoteEmailProvider } from "../quotes/quoteEmailProvider.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import type { ToolExecutionDefinition } from "./toolExecution.js";

export const QUOTE_SEND_TOOL = "quotes";
export const QUOTE_SEND_OPERATION = "send";

export const quoteSendArgumentsSchema = z
  .object({
    quoteId: z.string().trim().min(1).max(256),
    quoteRevision: z.number().int().min(1),
    recipient: z.string().trim().min(3).max(320).email(),
    deliveryChannel: z.literal("email"),
  })
  .strict();

export type QuoteSendResult = {
  quoteId: string;
  revision: number;
  recipient: string;
};

export function createQuoteSendToolDefinition(
  quotes: QuoteRepository,
  provider: QuoteEmailProvider,
): ToolExecutionDefinition {
  return {
    tool: QUOTE_SEND_TOOL,
    operation: QUOTE_SEND_OPERATION,
    externalProvider: provider.name,
    schema: quoteSendArgumentsSchema,
    async execute(argumentsValue, signal, context): Promise<QuoteSendResult> {
      const parsed = quoteSendArgumentsSchema.parse(argumentsValue);
      const snapshot = await quotes.getQuote(parsed.quoteId);
      if (!snapshot) {
        throw new Error(`Quote ${parsed.quoteId} does not exist.`);
      }
      if (snapshot.aggregate.currentRevision !== parsed.quoteRevision) {
        throw new Error(
          `Quote ${parsed.quoteId} revision ${parsed.quoteRevision} is no longer the current revision; the approval is stale.`,
        );
      }
      if (snapshot.revision.status !== "finalized") {
        throw new Error(
          `Quote ${parsed.quoteId} revision ${parsed.quoteRevision} is not finalized and cannot be sent.`,
        );
      }

      const result = await provider.send(
        { quoteId: parsed.quoteId, revision: snapshot.revision, recipient: parsed.recipient },
        signal,
      );
      await context.registerProviderAttempt({
        provider: provider.name,
        providerRequestId: result.providerRequestId,
        providerCorrelationId: result.providerCorrelationId,
      });

      return {
        quoteId: parsed.quoteId,
        revision: parsed.quoteRevision,
        recipient: parsed.recipient,
      };
    },
  };
}
