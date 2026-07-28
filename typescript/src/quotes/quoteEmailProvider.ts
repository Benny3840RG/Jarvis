import type { QuoteRevision } from "./quoteLifecycle.js";

export type QuoteEmailSendInput = {
  quoteId: string;
  revision: QuoteRevision;
  recipient: string;
};

export type QuoteEmailAttachment = {
  filename: string;
  mediaType: "application/pdf";
  digest: string;
  bytes: Uint8Array;
};

export type QuoteEmailPrepareInput = QuoteEmailSendInput & {
  subject: string;
  body: string;
  attachment: QuoteEmailAttachment;
};

export type QuoteEmailPreparedReference = {
  providerRequestId: string;
  providerCorrelationId: string;
};

export type QuoteEmailSendAcceptance = {
  status: "accepted";
};

export type QuoteEmailSendResult = QuoteEmailPreparedReference;

/**
 * Sends a finalized quote by email through a concrete provider (Postmark,
 * Resend, SES, ...). No implementation is registered yet — see
 * `createQuoteEmailProviderFromEnv` below — so `quotes:send` stays
 * unreachable (no execution definition is registered) until a vendor is
 * chosen and wired in a follow-up change.
 */
export interface QuoteEmailProvider {
  readonly name: string;
  prepare(
    input: QuoteEmailPrepareInput,
    signal: AbortSignal,
  ): Promise<QuoteEmailPreparedReference>;
  sendPrepared(
    reference: QuoteEmailPreparedReference,
    signal: AbortSignal,
  ): Promise<QuoteEmailSendAcceptance>;
}

/**
 * Returns `null` until a real email vendor is configured. Jarvis's execution
 * engine only allowlists `quotes:send` when both a `QuoteRepository` and a
 * `QuoteEmailProvider` are supplied (see `toolExecutionFactory.ts`), so an
 * unconfigured environment leaves quote sending correctly unreachable rather
 * than allowlisting a tool with nothing behind it.
 */
export function createQuoteEmailProviderFromEnv(): QuoteEmailProvider | null {
  return null;
}
