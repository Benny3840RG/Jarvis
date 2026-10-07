import type { Quote, QuoteStatus } from "../quotes/quote.js";
import type {
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
} from "../quotes/quoteDeliveryRepository.js";
import type {
  QuoteCommercialStatus,
  QuoteRevision,
  QuoteRevisionStatus,
  QuoteSnapshot,
} from "../quotes/quoteLifecycle.js";
import type { QuoteRepository, QuoteSummary } from "../quotes/quoteRepository.js";

/**
 * The daily brief and the HUD share this register. Commercial outcome wins:
 * accepted stays accepted, and declined or expired are closed (the brief has
 * no expired bucket, so expired counts as declined and leaves the pipeline).
 * An open finalized revision is sent only when `hasSucceededDelivery` is true,
 * and that flag is set only from a succeeded receipt already stored for that
 * revision. Finalize alone is not a send. Anything else that is still open
 * stays a draft.
 */
export function briefQuoteStatus(input: {
  revisionStatus: QuoteRevisionStatus;
  commercialStatus: QuoteCommercialStatus;
  hasSucceededDelivery: boolean;
}): QuoteStatus {
  if (input.commercialStatus === "accepted") return "accepted";
  if (input.commercialStatus === "declined" || input.commercialStatus === "expired") {
    return "declined";
  }
  if (input.revisionStatus === "finalized" && input.hasSucceededDelivery) return "sent";
  return "draft";
}

/**
 * A receipt counts only when it is the succeeded outcome for this exact
 * revision. Pending, failed, and indeterminate attempts are not sends.
 * Reconciliation counts only after it records `succeeded`.
 */
export function succeededDeliveryReceiptForRevision(
  attempt: QuoteDeliveryAttempt,
  revision: QuoteRevision,
): boolean {
  const fingerprint = revision.fingerprint;
  if (!fingerprint) return false;
  if (attempt.quoteId !== revision.quoteId) return false;
  if (attempt.revision !== revision.revision) return false;
  if (attempt.revisionId !== revision.revisionId) return false;
  if (attempt.revisionFingerprint !== fingerprint) return false;
  if (attempt.status === "succeeded") return true;
  return attempt.status === "reconciled" && attempt.reconciledOutcome === "succeeded";
}

export function quoteFromLifecycleSnapshot(
  snapshot: QuoteSnapshot,
  input: { hasSucceededDelivery: boolean },
): Quote {
  const { aggregate, revision } = snapshot;
  return {
    id: aggregate.quoteId,
    clientId: aggregate.clientId,
    ...(aggregate.projectId === undefined ? {} : { projectId: aggregate.projectId }),
    number: aggregate.number,
    status: briefQuoteStatus({
      revisionStatus: revision.status,
      commercialStatus: aggregate.commercialStatus,
      hasSucceededDelivery: input.hasSucceededDelivery,
    }),
    lineItems: revision.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
    subtotal: revision.subtotal,
    ...(revision.taxRate === undefined ? {} : { taxRate: revision.taxRate }),
    tax: revision.tax,
    total: revision.total,
    ...(revision.validUntil === undefined ? {} : { validUntil: revision.validUntil }),
    ...(revision.notes === undefined ? {} : { notes: revision.notes }),
    createdAt: aggregate.createdAt,
    updatedAt: aggregate.updatedAt,
  };
}

export class LifecycleQuoteRegisterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleQuoteRegisterError";
  }
}

/**
 * One read of the quote lifecycle register: the summaries the HUD already
 * lists, and the same rows projected into the brief's quote shape. Sent is
 * read from the existing delivery ledger for that revision. A missing snapshot,
 * a row that moved mid-read, or an unreadable delivery ledger fails closed.
 * Callers must not merge this result with the flat quote store.
 */
export async function readLifecycleQuoteRegister(
  repository: QuoteRepository,
  deliveries: QuoteDeliveryRepository | null,
): Promise<{
  summaries: QuoteSummary[];
  quotes: Quote[];
}> {
  let summaries: QuoteSummary[];
  try {
    summaries = await repository.listQuotes({});
  } catch (error: unknown) {
    throw new LifecycleQuoteRegisterError(
      error instanceof Error ? error.message : "The quote lifecycle register could not be read.",
    );
  }
  const quotes: Quote[] = [];
  for (const summary of summaries) {
    let snapshot: QuoteSnapshot | null;
    try {
      snapshot = await repository.getQuote(summary.quoteId);
    } catch (error: unknown) {
      throw new LifecycleQuoteRegisterError(
        error instanceof Error ? error.message : "The quote lifecycle register could not be read.",
      );
    }
    if (
      !snapshot ||
      snapshot.aggregate.quoteId !== summary.quoteId ||
      snapshot.aggregate.currentRevision !== summary.currentRevision ||
      snapshot.revision.status !== summary.revisionStatus ||
      snapshot.aggregate.commercialStatus !== summary.commercialStatus ||
      snapshot.revision.total !== summary.total
    ) {
      throw new LifecycleQuoteRegisterError(
        `Quote ${summary.quoteId} is not a consistent row of the lifecycle register.`,
      );
    }
    quotes.push(
      quoteFromLifecycleSnapshot(snapshot, {
        hasSucceededDelivery: await succeededDeliveryForSnapshot(deliveries, snapshot),
      }),
    );
  }
  return { summaries, quotes };
}

async function succeededDeliveryForSnapshot(
  deliveries: QuoteDeliveryRepository | null,
  snapshot: QuoteSnapshot,
): Promise<boolean> {
  if (snapshot.revision.status !== "finalized" || snapshot.aggregate.commercialStatus !== "open") {
    return false;
  }
  if (!deliveries) return false;
  let attempts: QuoteDeliveryAttempt[];
  try {
    attempts = await deliveries.listForQuote({
      quoteId: snapshot.aggregate.quoteId,
      revision: snapshot.revision.revision,
    });
  } catch (error: unknown) {
    throw new LifecycleQuoteRegisterError(
      error instanceof Error ? error.message : "The quote delivery ledger could not be read.",
    );
  }
  return attempts.some((attempt) =>
    succeededDeliveryReceiptForRevision(attempt, snapshot.revision),
  );
}
