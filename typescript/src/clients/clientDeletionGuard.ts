import type { EnquiryStore } from "../enquiries/enquiry.js";
import type { InvoiceStore } from "../invoices/invoice.js";
import type { PropertyStore } from "../properties/property.js";
import type { ProjectStore } from "../projects/project.js";
import type { QuoteStore } from "../quotes/quote.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";

/** Records that still point at a client and must survive a client delete. */
export const CLIENT_REFERENCE_KINDS = [
  "enquiry",
  "invoice",
  "property",
  "project",
  "quote",
  "quote-lifecycle",
] as const;

export type ClientReferenceKind = (typeof CLIENT_REFERENCE_KINDS)[number];

export type ClientDeletionStores = {
  enquiries: EnquiryStore;
  invoices: InvoiceStore;
  properties: PropertyStore;
  projects: ProjectStore;
  quotes: QuoteStore;
  /** Null when the Convex quote lifecycle is not configured. */
  quoteRepository: QuoteRepository | null;
};

/**
 * Names every store that still references `clientId`. Store failures propagate
 * so the caller can fail closed instead of deleting past an unread ledger.
 */
export async function findClientDeletionReferences(
  clientId: string,
  stores: ClientDeletionStores,
): Promise<ClientReferenceKind[]> {
  const kinds: ClientReferenceKind[] = [];
  if ((await stores.enquiries.list({ clientId })).length > 0) kinds.push("enquiry");
  if ((await stores.invoices.list({ clientId })).length > 0) kinds.push("invoice");
  if ((await stores.properties.list({ clientId })).length > 0) kinds.push("property");
  if ((await stores.projects.list()).some((project) => project.clientId === clientId)) {
    kinds.push("project");
  }
  if ((await stores.quotes.list()).some((quote) => quote.clientId === clientId)) {
    kinds.push("quote");
  }
  if (
    stores.quoteRepository !== null &&
    (await stores.quoteRepository.listQuotes({ clientId })).some(
      (quote) => quote.clientId === clientId,
    )
  ) {
    kinds.push("quote-lifecycle");
  }
  return kinds;
}

const REFERENCE_LABELS: Record<ClientReferenceKind, string> = {
  enquiry: "an enquiry",
  invoice: "an invoice",
  property: "a property",
  project: "a project",
  quote: "a quote",
  "quote-lifecycle": "a quote lifecycle revision",
};

export function clientStillReferencedDetail(kinds: readonly ClientReferenceKind[]): string {
  const labels = kinds.map((kind) => REFERENCE_LABELS[kind]);
  const list =
    labels.length <= 1
      ? (labels[0] ?? "another record")
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `This client is still referenced by ${list}.`;
}
