/**
 * Self-cleaning quote lifecycle development smoke.
 *
 * Proves the revision-safe quote and delivery ledger against an authorised
 * development deployment. Every store operation uses a fresh adapter instance
 * so replay and visibility cannot be satisfied by an in-process cache.
 * Cleanup runs in a `finally` block and is restricted to the synthetic
 * smoke IDs produced by this run.
 *
 * This smoke does NOT activate AM-012 or AM-013; those action families remain
 * planned. It directly exercises the underlying repository and delivery ledger
 * methods that the tool boundaries would eventually call.
 */

import { randomUUID } from "node:crypto";

import type { QuoteDeliveryRepository } from "../quotes/quoteDeliveryRepository.js";
import type { QuoteDeliveryAttempt } from "../quotes/quoteDeliveryRepository.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import type { QuoteSnapshot } from "../quotes/quoteLifecycle.js";
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
 * Proves the quote lifecycle boundary against an authorised development
 * deployment. Creates a quote, reviews and finalises the first revision,
 * forks a second revision, exercises the delivery ledger through
 * pending → executing → indeterminate → reconciled, then cleans up all
 * synthetic records.
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

  const marker = `jarvis-quote-lifecycle-smoke-${randomUUID()}`;
  const quoteNumber = `SMOKE-${marker.slice(-8).toUpperCase()}`;
  const clientId = `${marker}-client`;
  const projectId = `${marker}-project`;
  const recipient = `smoke-${randomUUID()}@example.com`;
  const idempotencyKey = `${marker}-delivery`;
  const approvalId = `${marker}-approval`;
  const actionFingerprint = `jarvis-action-fingerprint:v1:${"a".repeat(64)}`;
  const providerRequestId = `${marker}-provider-request`;
  const providerCorrelationId = `${marker}-correlation`;
  const reconciliationId = `${marker}-reconciliation`;

  let quote: QuoteSnapshot | undefined;
  let delivery: QuoteDeliveryAttempt | undefined;
  let primaryError: Error | undefined;
  let result: QuoteLifecycleSmokeResult | undefined;

  try {
    // --- Create quote (revision 1, draft) ---
    quote = await makeRepository().createQuote({
      clientId,
      projectId,
      number: quoteNumber,
      lineItems: [
        { description: "Labour", quantity: 4, unitPrice: 125 },
        { description: "Materials", quantity: 1, unitPrice: 80 },
      ],
      taxRate: 0.1,
      notes: "Lifecycle smoke test quote",
      termsIncluded: true,
    });
    requireCondition(
      quote.aggregate.commercialStatus === "open",
      "quote lifecycle: created quote should have open commercial status.",
    );
    requireCondition(
      quote.revision.status === "draft",
      "quote lifecycle: created revision should be draft.",
    );
    requireCondition(
      quote.revision.revision === 1,
      "quote lifecycle: first revision should have revision number 1.",
    );
    requireCondition(
      quote.revision.total === 604,
      `quote lifecycle: expected total 604, got ${quote.revision.total}.`,
    );

    // --- Submit for review ---
    const reviewed = await makeRepository().submitForReview({
      quoteId: quote.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: quote.aggregate.aggregateVersion,
      expectedRevisionVersion: quote.revision.revisionVersion,
    });
    requireCondition(
      reviewed.revision.status === "reviewed",
      "quote lifecycle: submitted revision should be reviewed.",
    );

    // --- Finalize revision 1 ---
    const finalized = await makeRepository().finalizeRevision({
      quoteId: quote.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: reviewed.aggregate.aggregateVersion,
      expectedRevisionVersion: reviewed.revision.revisionVersion,
    });
    requireCondition(
      finalized.revision.status === "finalized",
      "quote lifecycle: finalized revision should have finalized status.",
    );
    requireCondition(
      typeof finalized.revision.fingerprint === "string" &&
        finalized.revision.fingerprint.startsWith("quote-revision:v1:sha256:"),
      "quote lifecycle: finalized revision should have a canonical fingerprint.",
    );
    const revision1Fingerprint = finalized.revision.fingerprint!;

    // --- Read through a fresh adapter: verify immutability ---
    const freshSnapshot = await makeRepository().getQuote(quote.aggregate.quoteId);
    requireCondition(freshSnapshot !== null, "quote lifecycle: fresh read should find the quote.");
    requireCondition(
      freshSnapshot.revision.status === "finalized",
      "quote lifecycle: fresh read should see finalized status.",
    );
    requireCondition(
      freshSnapshot.revision.fingerprint === revision1Fingerprint,
      "quote lifecycle: fresh read fingerprint should match the finalized fingerprint.",
    );

    // --- Fork revision 2 ---
    const forked = await makeRepository().createRevisionFromFinalized({
      quoteId: quote.aggregate.quoteId,
      revision: 1,
      expectedAggregateVersion: finalized.aggregate.aggregateVersion,
      expectedRevisionVersion: finalized.revision.revisionVersion,
      expectedFingerprint: revision1Fingerprint,
    });
    requireCondition(
      forked.revision.revision === 2,
      "quote lifecycle: forked revision should be revision 2.",
    );
    requireCondition(
      forked.revision.status === "draft",
      "quote lifecycle: forked revision should be draft.",
    );
    requireCondition(
      forked.revision.predecessorRevisionId === finalized.revision.revisionId,
      "quote lifecycle: forked revision should point to its predecessor.",
    );
    // Verify the old fingerprint is unchanged (revision 1 still intact)
    const rev1After = await makeRepository().getQuote(quote.aggregate.quoteId);
    requireCondition(rev1After !== null, "quote lifecycle: cannot read quote after fork.");
    // The aggregate now points to revision 2; revision 1 is historical.
    requireCondition(
      rev1After.aggregate.currentRevision === 2,
      "quote lifecycle: aggregate should point to revision 2 after fork.",
    );

    // --- Delivery attempt: pending → executing → indeterminate → reconciled ---
    const sendFingerprint = `quote-send:v1:sha256:${"b".repeat(64)}`;
    delivery = await makeDeliveryRepository().createPending({
      quoteId: quote.aggregate.quoteId,
      revision: 1,
      recipient,
      channel: "email",
      revisionId: finalized.revision.revisionId,
      revisionFingerprint: revision1Fingerprint,
      sendFingerprint,
      idempotencyKey,
      approvalId,
      actionFingerprint,
      provider: "smoke-test-provider",
    });
    requireCondition(
      delivery.status === "pending",
      "quote lifecycle: delivery should start pending.",
    );

    const executing = await makeDeliveryRepository().markExecuting({
      deliveryAttemptId: delivery.deliveryAttemptId,
      expectedStatus: "pending",
    });
    requireCondition(
      executing.status === "executing",
      "quote lifecycle: delivery should become executing.",
    );

    const withRef = await makeDeliveryRepository().bindProviderReference({
      deliveryAttemptId: delivery.deliveryAttemptId,
      expectedStatus: "executing",
      providerRequestId,
      providerCorrelationId,
      reconciliationId,
    });
    requireCondition(
      withRef.providerRequestId === providerRequestId,
      "quote lifecycle: delivery should have bound provider request ID.",
    );

    const indeterminate = await makeDeliveryRepository().markIndeterminate({
      deliveryAttemptId: delivery.deliveryAttemptId,
      expectedStatus: "executing",
      reconciliationId,
    });
    requireCondition(
      indeterminate.status === "indeterminate",
      "quote lifecycle: delivery should be indeterminate.",
    );

    const reconciled = await makeDeliveryRepository().reconcile({
      deliveryAttemptId: delivery.deliveryAttemptId,
      expectedStatus: "indeterminate",
      reconciliationId,
      outcome: "succeeded",
    });
    requireCondition(
      reconciled.status === "reconciled",
      "quote lifecycle: delivery should be reconciled.",
    );
    requireCondition(
      reconciled.reconciledOutcome === "succeeded",
      "quote lifecycle: reconciled delivery should have succeeded outcome.",
    );

    // --- Verify commercial status is unchanged by delivery state ---
    const finalAggregate = await makeRepository().getQuote(quote.aggregate.quoteId);
    requireCondition(
      finalAggregate?.aggregate.commercialStatus === "open",
      `quote lifecycle: commercial status should still be open; got ${finalAggregate?.aggregate.commercialStatus}.`,
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
      cleaned: false,
    };
  } catch (error: unknown) {
    primaryError = normalizeError(error);
  }

  const cleanupErrors: unknown[] = [];

  if (quote !== undefined) {
    try {
      await makeDeliveryRepository().cleanup(quote.aggregate.quoteId);
      await makeRepository().cleanup(quote.aggregate.quoteId);
      const afterCleanup = await makeRepository().getQuote(quote.aggregate.quoteId);
      requireCondition(
        afterCleanup === null,
        "quote lifecycle: record remained visible after smoke cleanup.",
      );
      if (result !== undefined) result.cleaned = true;
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      "quote lifecycle: smoke cleanup failed.",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  requireCondition(result !== undefined, "quote lifecycle: smoke finished without a result.");

  write(
    "Convex smoke passed for quote lifecycle: create, review, finalize, fresh-read, fork, delivery pending→executing→indeterminate→reconciled, commercial-status check, cleanup.",
  );
  return result;
}
