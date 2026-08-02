import { createMicrosoftOutlookRuntimeFromEnv } from "../auth/microsoftOutlookRuntime.js";
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

export interface QuoteEmailProvider {
  readonly name: string;
  prepare(input: QuoteEmailPrepareInput, signal: AbortSignal): Promise<QuoteEmailPreparedReference>;
  sendPrepared(
    reference: QuoteEmailPreparedReference,
    signal: AbortSignal,
  ): Promise<QuoteEmailSendAcceptance>;
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Returns the delegated Microsoft Graph quote provider only after strict
 * Outlook configuration has been explicitly enabled. Construction performs no
 * token or Graph I/O; those remain lazy until an approved quote execution.
 */
export function createQuoteEmailProviderFromEnv(
  environment: Environment = process.env,
): QuoteEmailProvider | null {
  return createMicrosoftOutlookRuntimeFromEnv(environment)?.quoteEmailProvider ?? null;
}
