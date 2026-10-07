import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clientStillReferencedDetail,
  findClientDeletionReferences,
  type ClientDeletionStores,
} from "../src/clients/clientDeletionGuard.js";
import { InMemoryEnquiryStore } from "../src/enquiries/inMemoryEnquiryStore.js";
import { InMemoryInvoiceStore } from "../src/invoices/inMemoryInvoiceStore.js";
import { InMemoryProjectStore } from "../src/projects/inMemoryProjectStore.js";
import { InMemoryPropertyStore } from "../src/properties/inMemoryPropertyStore.js";
import { InMemoryQuoteStore } from "../src/quotes/inMemoryQuoteStore.js";
import type { QuoteRepository, QuoteSummary } from "../src/quotes/quoteRepository.js";

const CLIENT_ID = "client-referenced";

function stores(overrides: Partial<ClientDeletionStores> = {}): ClientDeletionStores {
  return {
    enquiries: new InMemoryEnquiryStore(),
    invoices: new InMemoryInvoiceStore(),
    properties: new InMemoryPropertyStore(),
    projects: new InMemoryProjectStore(),
    quotes: new InMemoryQuoteStore(),
    quoteRepository: null,
    ...overrides,
  };
}

function lifecycleRepository(summaries: QuoteSummary[]): QuoteRepository {
  const unused = async (): Promise<never> => {
    throw new Error("unused in client deletion guard test");
  };
  return {
    createQuote: unused,
    getQuote: unused,
    listQuotes: () => Promise.resolve(summaries),
    updateDraft: unused,
    submitForReview: unused,
    reopenForEditing: unused,
    finalizeRevision: unused,
    createRevisionFromFinalized: unused,
    recordCommercialOutcome: unused,
    cleanup: unused,
  };
}

describe("findClientDeletionReferences", () => {
  it("reports no references for an unlinked client", async () => {
    assert.deepEqual(await findClientDeletionReferences(CLIENT_ID, stores()), []);
  });

  it("reports a flat quote and a quote-lifecycle revision", async () => {
    const quotes = new InMemoryQuoteStore();
    await quotes.add({ clientId: CLIENT_ID, number: "Q-FLAT-1" });
    const quoteRepository = lifecycleRepository([
      {
        quoteId: "quote-1",
        clientId: CLIENT_ID,
        number: "Q-LIFE-1",
        currentRevision: 1,
        aggregateVersion: 1,
        revisionStatus: "finalized",
        commercialStatus: "open",
        total: 10,
        currency: "AUD",
        updatedAt: 1,
      },
    ]);

    assert.deepEqual(
      await findClientDeletionReferences(CLIENT_ID, stores({ quotes, quoteRepository })),
      ["quote", "quote-lifecycle"],
    );
    assert.equal(
      clientStillReferencedDetail(["quote", "quote-lifecycle"]),
      "This client is still referenced by a quote and a quote lifecycle revision.",
    );
  });

  it("ignores quotes that belong to a different client", async () => {
    const quotes = new InMemoryQuoteStore();
    await quotes.add({ clientId: "someone-else", number: "Q-OTHER" });
    const quoteRepository = lifecycleRepository([
      {
        quoteId: "quote-2",
        clientId: "someone-else",
        number: "Q-OTHER-LIFE",
        currentRevision: 1,
        aggregateVersion: 1,
        revisionStatus: "draft",
        commercialStatus: "open",
        total: 0,
        currency: "AUD",
        updatedAt: 1,
      },
    ]);

    assert.deepEqual(
      await findClientDeletionReferences(CLIENT_ID, stores({ quotes, quoteRepository })),
      [],
    );
  });

  it("propagates a reference-store failure instead of treating it as clear", async () => {
    const enquiries = new InMemoryEnquiryStore();
    enquiries.list = () => Promise.reject(new Error("enquiry ledger unreadable"));

    await assert.rejects(
      () => findClientDeletionReferences(CLIENT_ID, stores({ enquiries })),
      /enquiry ledger unreadable/,
    );
  });
});
