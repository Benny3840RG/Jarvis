import { randomUUID } from "node:crypto";

import type { QuoteDeliveryRepository } from "../quotes/quoteDeliveryRepository.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import type { SmokeWriter } from "./convexSmoke.js";

export type QuoteLifecycleSmokeResult = {
  quoteCreated: boolean;
  revisionReviewed: boolean;
  revisionFinalized: boolean;
  freshReadImmutable: boolean;
  revisionForked: boolean;
  deliveryCreated: boolean;
  deliveryExecuting: boolean;
  providerReferencesBound: boolean;
  deliveryIndeterminate: boolean;
  deliveryReconciled: boolean;
  commercialStatusPreserved: boolean;
  cleaned: boolean;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * End-to-end development smoke test for the quote revision lifecycle and its
 * delivery ledger, mirroring `runExternalReconciliationSmoke`'s structure:
 * every synthetic record is created under a random marker and torn down via
 * the dev-only `cleanup()` methods, whether the run succeeds or fails partway.
 */
export async function runQuoteLifecycleSmoke(
  makeRepository: () => QuoteRepository,
  makeDeliveryRepository: () => QuoteDeliveryRepository,
  deployment: string | undefined,
  write: SmokeWriter = (message) => console.log(message),
): Promise<QuoteLifecycleSmokeResult> {
  if (!deployment?.trim().startsWith("dev:")) {
    throw new Error(
      "Quote lifecycle smoke refused: CONVEX_DEPLOYMENT must identify a development deployment (dev:...).",
    );
  }

  // Resolve every credential-bearing dependency before the first synthetic
  // write. A missing delivery-runtime credential must not leave a quote that
  // the same unavailable dependency then prevents the smoke from cleaning.
  const quoteRepository = makeRepository();
  const deliveryRepository = makeDeliveryRepository();

  const marker = `jarvis-quote-lifecycle-smoke-${randomUUID()}`;
  const recipient = `${marker}@example.invalid`;
  const reconciliationId = `${marker}-reconciliation`;
  const providerRequestId = `${marker}-provider-request`;
  const providerCorrelationId = `${marker}-provider-correlation`;

  let quoteId: string | undefined;
  let quoteCleaned = false;
  let deliveryCleaned = false;
  let primaryError: Error | undefined;
  let result: QuoteLifecycleSmokeResult | undefined;

  try {
    const created = await quoteRepository.createQuote({
      clientId: `${marker}-client`,
      number: `Q-${marker}`,
      lineItems: [{ description: "Smoke line item", quantity: 1, unitPrice: 100 }],
      termsIncluded: true,
    });
    quoteId = created.aggregate.quoteId;
    requireCondition(
      created.revision.status === "draft" && created.aggregate.aggregateVersion === 1,
      "quote lifecycle: creation did not persist a draft revision at version 1.",
    );

    const reviewed = await quoteRepository.submitForReview({
      quoteId,
      revision: 1,
      expectedAggregateVersion: created.aggregate.aggregateVersion,
      expectedRevisionVersion: created.revision.revisionVersion,
    });
    requireCondition(
      reviewed.revision.status === "reviewed",
      "quote lifecycle: submitForReview did not transition the revision to reviewed.",
    );

    const finalized = await quoteRepository.finalizeRevision({
      quoteId,
      revision: 1,
      expectedAggregateVersion: reviewed.aggregate.aggregateVersion,
      expectedRevisionVersion: reviewed.revision.revisionVersion,
      issuer: {
        name: "Jarvis Smoke Issuer",
        email: "issuer@example.invalid",
      },
      client: {
        name: "Jarvis Smoke Client",
        email: recipient,
      },
    });
    requireCondition(
      finalized.revision.status === "finalized" && finalized.revision.fingerprint !== undefined,
      "quote lifecycle: finalizeRevision did not stamp a fingerprint.",
    );

    const freshRead = await quoteRepository.getQuote(quoteId);
    requireCondition(
      freshRead !== null &&
        freshRead.revision.fingerprint === finalized.revision.fingerprint &&
        freshRead.revision.status === "finalized",
      "quote lifecycle: a fresh repository instance did not read back the same finalized fingerprint.",
    );

    const forked = await quoteRepository.createRevisionFromFinalized({
      quoteId,
      revision: 1,
      expectedAggregateVersion: freshRead.aggregate.aggregateVersion,
      expectedRevisionVersion: freshRead.revision.revisionVersion,
      expectedFingerprint: finalized.revision.fingerprint,
    });
    requireCondition(
      forked.aggregate.currentRevision === 2 &&
        forked.revision.status === "draft" &&
        forked.revision.predecessorRevisionId === finalized.revision.revisionId,
      "quote lifecycle: createRevisionFromFinalized did not fork a new draft revision.",
    );

    const pending = await deliveryRepository.createPending({
      quoteId,
      revision: 1,
      recipient,
      channel: "email",
      revisionId: finalized.revision.revisionId,
      revisionFingerprint: finalized.revision.fingerprint,
      sendFingerprint: `${marker}-send-fingerprint`,
      idempotencyKey: `${marker}-idempotency`,
      approvalId: `${marker}-approval`,
      actionFingerprint: `${marker}-action-fingerprint`,
      provider: "jarvis-commissioning-provider",
    });
    requireCondition(
      pending.status === "pending",
      "quote lifecycle: createPending did not persist a pending delivery attempt.",
    );

    const executing = await deliveryRepository.markExecuting({
      deliveryAttemptId: pending.deliveryAttemptId,
      expectedStatus: "pending",
    });
    requireCondition(
      executing.status === "executing",
      "quote lifecycle: markExecuting did not transition the delivery attempt.",
    );

    const bound = await deliveryRepository.bindProviderReference({
      deliveryAttemptId: pending.deliveryAttemptId,
      expectedStatus: "executing",
      providerRequestId,
      providerCorrelationId,
      reconciliationId,
    });
    requireCondition(
      bound.providerRequestId === providerRequestId &&
        bound.providerCorrelationId === providerCorrelationId,
      "quote lifecycle: bindProviderReference did not persist the durable provider reference.",
    );

    const indeterminate = await deliveryRepository.markIndeterminate({
      deliveryAttemptId: pending.deliveryAttemptId,
      expectedStatus: "executing",
      reconciliationId,
    });
    requireCondition(
      indeterminate.status === "indeterminate" &&
        indeterminate.reconciliationId === reconciliationId,
      "quote lifecycle: markIndeterminate did not persist the pending reconciliation.",
    );

    const reconciled = await deliveryRepository.reconcile({
      deliveryAttemptId: pending.deliveryAttemptId,
      expectedStatus: "indeterminate",
      reconciliationId,
      outcome: "succeeded",
    });
    requireCondition(
      reconciled.status === "reconciled" && reconciled.reconciledOutcome === "succeeded",
      "quote lifecycle: reconcile did not persist the terminal delivery outcome.",
    );

    const afterDelivery = await quoteRepository.getQuote(quoteId);
    requireCondition(
      afterDelivery !== null && afterDelivery.aggregate.commercialStatus === "open",
      "quote lifecycle: an unrelated delivery/fork mutated the quote's commercial status.",
    );

    requireCondition(
      await quoteRepository.cleanup(quoteId),
      "quote lifecycle: cleanup did not remove the synthetic quote and its revisions.",
    );
    quoteCleaned = true;
    requireCondition(
      await deliveryRepository.cleanup(quoteId),
      "quote lifecycle: cleanup did not remove the synthetic delivery attempts.",
    );
    deliveryCleaned = true;
    requireCondition(
      (await quoteRepository.getQuote(quoteId)) === null,
      "quote lifecycle: synthetic quote remained visible after cleanup.",
    );
    requireCondition(
      (await deliveryRepository.listForQuote({ quoteId })).length === 0,
      "quote lifecycle: synthetic delivery attempts remained visible after cleanup.",
    );

    result = {
      quoteCreated: true,
      revisionReviewed: true,
      revisionFinalized: true,
      freshReadImmutable: true,
      revisionForked: true,
      deliveryCreated: true,
      deliveryExecuting: true,
      providerReferencesBound: true,
      deliveryIndeterminate: true,
      deliveryReconciled: true,
      commercialStatusPreserved: true,
      cleaned: true,
    };
  } catch (error: unknown) {
    primaryError = normalizeError(error);
  }

  const cleanupErrors: unknown[] = [];
  if (quoteId !== undefined && !quoteCleaned) {
    try {
      await quoteRepository.cleanup(quoteId);
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  if (quoteId !== undefined && !deliveryCleaned) {
    try {
      await deliveryRepository.cleanup(quoteId);
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      "quote lifecycle smoke cleanup failed.",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  requireCondition(result !== undefined, "quote lifecycle smoke finished without a result.");

  write(
    "Convex smoke passed for quote lifecycle: creation, review, finalization, immutability, forking, delivery ledger and cleanup.",
  );
  return result;
}
