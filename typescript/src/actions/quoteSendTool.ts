import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
} from "../quotes/quoteDeliveryRepository.js";
import type { QuoteEmailProvider, QuoteEmailSendResult } from "../quotes/quoteEmailProvider.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import { canonicalJson } from "./canonicalJson.js";
import { computeExternalReconciliationId, type ToolExecutionDefinition } from "./toolExecution.js";

export const QUOTE_SEND_TOOL = "quotes";
export const QUOTE_SEND_OPERATION = "send";
const SEND_FINGERPRINT_VERSION = "quote-send-fingerprint:v1";

export const quoteSendArgumentsSchema = z
  .object({
    quoteId: z.string().trim().min(1).max(256),
    quoteRevision: z.number().int().min(1),
    recipient: z.string().trim().min(3).max(320).email(),
    deliveryChannel: z.literal("email"),
    expectedRevisionFingerprint: z.string().trim().min(1).max(200),
  })
  .strict();

export type QuoteSendResult = {
  quoteId: string;
  revision: number;
  recipient: string;
};

function sendFingerprint(input: {
  quoteId: string;
  revision: number;
  recipient: string;
  channel: "email";
  revisionFingerprint: string;
}): string {
  const hash = createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
  return `${SEND_FINGERPRINT_VERSION}:sha256:${hash}`;
}

function errorCode(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/**
 * Best-effort projection into the quote-scoped delivery ledger. The ledger is
 * a queryable read model (`GET /api/v1/quotes/:id/deliveries`), not the
 * source of truth for exactly-once delivery — that guarantee is owned by
 * `ToolExecutionService`/`ExternalReconciliationStore`, which this tool still
 * goes through via `context.registerProviderAttempt`. A failure updating the
 * ledger is logged and swallowed rather than thrown, so a projection hiccup
 * never corrupts the authoritative execution outcome.
 */
async function project(action: () => Promise<QuoteDeliveryAttempt>): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    console.warn(`Quote delivery ledger projection failed: ${errorCode(error)}`);
  }
}

export function createQuoteSendToolDefinition(
  quotes: QuoteRepository,
  provider: QuoteEmailProvider,
  deliveries: QuoteDeliveryRepository,
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
      if (snapshot.revision.status !== "finalized" || !snapshot.revision.fingerprint) {
        throw new Error(
          `Quote ${parsed.quoteId} revision ${parsed.quoteRevision} is not finalized and cannot be sent.`,
        );
      }
      if (snapshot.revision.fingerprint !== parsed.expectedRevisionFingerprint) {
        throw new Error(
          `Quote ${parsed.quoteId} revision ${parsed.quoteRevision} fingerprint has changed since approval; a new approval is required.`,
        );
      }

      const scope = {
        quoteId: parsed.quoteId,
        revision: parsed.quoteRevision,
        recipient: parsed.recipient,
        channel: parsed.deliveryChannel,
      } as const;
      const fingerprint = sendFingerprint({
        ...scope,
        revisionFingerprint: snapshot.revision.fingerprint,
      });

      const existing = await deliveries.getBySendScope(scope);
      if (existing) {
        throw new Error(
          existing.sendFingerprint === fingerprint
            ? `Quote ${parsed.quoteId} revision ${parsed.quoteRevision} already has a delivery attempt to ${parsed.recipient} (status: ${existing.status}); sending the same finalized revision to the same recipient twice is not permitted — fork a new revision to resend.`
            : `Quote ${parsed.quoteId} revision ${parsed.quoteRevision} already has a delivery attempt to ${parsed.recipient} with a different send fingerprint.`,
        );
      }

      const attempt = await deliveries.createPending({
        ...scope,
        revisionId: snapshot.revision.revisionId,
        revisionFingerprint: snapshot.revision.fingerprint,
        sendFingerprint: fingerprint,
        idempotencyKey: context.idempotencyKey,
        // ToolExecutionContext.approvalId is optional; the idempotency key is
        // a reasonable stand-in when absent since it already uniquely
        // identifies this approved action.
        approvalId: context.approvalId ?? context.idempotencyKey,
        actionFingerprint: context.actionFingerprint,
        provider: provider.name,
      });
      await project(() =>
        deliveries.markExecuting({
          deliveryAttemptId: attempt.deliveryAttemptId,
          expectedStatus: "pending",
        }),
      );

      const onAbort = (): void => {
        void project(() =>
          deliveries.markIndeterminate({
            deliveryAttemptId: attempt.deliveryAttemptId,
            expectedStatus: "executing",
            reconciliationId: computeExternalReconciliationId(
              context.action,
              context.idempotencyKey,
              context.effectFingerprint,
            ),
          }),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });

      let result: QuoteEmailSendResult;
      try {
        result = await provider.send(
          { quoteId: parsed.quoteId, revision: snapshot.revision, recipient: parsed.recipient },
          signal,
        );
      } catch (error: unknown) {
        if (!signal.aborted) {
          await project(() =>
            deliveries.complete({
              deliveryAttemptId: attempt.deliveryAttemptId,
              expectedStatus: "executing",
              outcome: "failed",
              providerErrorCode: errorCode(error),
            }),
          );
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }

      await project(() =>
        deliveries.bindProviderReference({
          deliveryAttemptId: attempt.deliveryAttemptId,
          expectedStatus: "executing",
          providerRequestId: result.providerRequestId,
          providerCorrelationId: result.providerCorrelationId,
          reconciliationId: computeExternalReconciliationId(
            context.action,
            context.idempotencyKey,
            context.effectFingerprint,
          ),
        }),
      );
      await context.registerProviderAttempt({
        provider: provider.name,
        providerRequestId: result.providerRequestId,
        providerCorrelationId: result.providerCorrelationId,
      });
      await project(() =>
        deliveries.complete({
          deliveryAttemptId: attempt.deliveryAttemptId,
          expectedStatus: "executing",
          outcome: "succeeded",
        }),
      );

      return {
        quoteId: parsed.quoteId,
        revision: parsed.quoteRevision,
        recipient: parsed.recipient,
      };
    },
  };
}
