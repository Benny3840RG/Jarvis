import type {
  QuoteEmailPrepareInput,
  QuoteEmailPreparedReference,
  QuoteEmailSendAcceptance,
} from "./quoteEmailProvider.js";

export type PreparedQuoteEmailProvider = {
  readonly name: string;
  prepare(input: QuoteEmailPrepareInput, signal: AbortSignal): Promise<QuoteEmailPreparedReference>;
  sendPrepared(
    reference: QuoteEmailPreparedReference,
    signal: AbortSignal,
  ): Promise<QuoteEmailSendAcceptance>;
};

export type RegisteredQuoteEmailReference = QuoteEmailPreparedReference & {
  provider: string;
};

export class QuoteEmailAcceptedIndeterminateError extends Error {
  readonly code = "quote-email-accepted-indeterminate";

  constructor() {
    super("quote-email-accepted-indeterminate");
    this.name = "QuoteEmailAcceptedIndeterminateError";
  }
}

type PrepareRegisterAndSendInput = {
  provider: PreparedQuoteEmailProvider;
  input: QuoteEmailPrepareInput;
  signal: AbortSignal;
  register(reference: RegisteredQuoteEmailReference): Promise<void>;
};

/**
 * Preserves the only safe order for an external mail send:
 *
 * 1. Create a recoverable provider-side draft.
 * 2. Persist its immutable provider reference.
 * 3. Attempt to send the prepared draft.
 * 4. Surface provider acceptance as indeterminate until reconciliation proves
 *    the terminal outcome.
 *
 * A registration failure is intentionally allowed to escape before the send
 * step can run.
 */
export async function prepareRegisterAndSendQuoteEmail(
  input: PrepareRegisterAndSendInput,
): Promise<never> {
  const prepared = await input.provider.prepare(input.input, input.signal);
  await input.register({
    provider: input.provider.name,
    providerRequestId: prepared.providerRequestId,
    providerCorrelationId: prepared.providerCorrelationId,
  });
  const acceptance = await input.provider.sendPrepared(prepared, input.signal);
  if (acceptance.status !== "accepted") {
    throw new Error("quote-email-provider-response-invalid");
  }
  throw new QuoteEmailAcceptedIndeterminateError();
}
