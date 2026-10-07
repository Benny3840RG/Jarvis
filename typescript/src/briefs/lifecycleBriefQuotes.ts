import type { Quote, QuoteStatus } from "../quotes/quote.js";
import type {
  QuoteCommercialStatus,
  QuoteRevisionStatus,
  QuoteSnapshot,
} from "../quotes/quoteLifecycle.js";
import type { QuoteRepository, QuoteSummary } from "../quotes/quoteRepository.js";

/**
 * The daily brief and the HUD share this register. Commercial outcome wins:
 * accepted stays accepted, and declined or expired are closed (the brief has
 * no expired bucket, so expired counts as declined and leaves the pipeline).
 * An open finalized revision is sent and awaiting a response. An open draft or
 * reviewed revision is still a draft.
 */
export function briefQuoteStatus(input: {
  revisionStatus: QuoteRevisionStatus;
  commercialStatus: QuoteCommercialStatus;
}): QuoteStatus {
  if (input.commercialStatus === "accepted") return "accepted";
  if (input.commercialStatus === "declined" || input.commercialStatus === "expired") {
    return "declined";
  }
  if (input.revisionStatus === "finalized") return "sent";
  return "draft";
}

export function quoteFromLifecycleSnapshot(snapshot: QuoteSnapshot): Quote {
  const { aggregate, revision } = snapshot;
  return {
    id: aggregate.quoteId,
    clientId: aggregate.clientId,
    ...(aggregate.projectId === undefined ? {} : { projectId: aggregate.projectId }),
    number: aggregate.number,
    status: briefQuoteStatus({
      revisionStatus: revision.status,
      commercialStatus: aggregate.commercialStatus,
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
 * lists, and the same rows projected into the brief's quote shape. A missing
 * snapshot or a row that moved mid-read fails closed. Callers must not merge
 * this result with the flat quote store.
 */
export async function readLifecycleQuoteRegister(repository: QuoteRepository): Promise<{
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
    quotes.push(quoteFromLifecycleSnapshot(snapshot));
  }
  return { summaries, quotes };
}
