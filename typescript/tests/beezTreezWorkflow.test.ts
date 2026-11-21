import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commissioningModeFromArgs,
  workflowFailure,
} from "../src/tools/runOutlookQuoteCommissioning.js";
import {
  assessBeezTreezWorkflow,
  finishBeezTreezWorkflow,
  invoiceIdsFrom,
  lineItemsFrom,
  readBriefCounts,
  startBeezTreezWorkflow,
  type EnquiryObservation,
  type HudObservation,
  type InvoiceObservation,
  type WorkflowCall,
} from "../src/tools/beezTreezWorkflow.js";

function brief(input: { draftInvoices: number; sentQuotes: number; awaiting: string[] }) {
  return {
    data: {
      invoices: { draftCount: input.draftInvoices, unpaidCount: 0, unpaidTotal: 0, unpaid: [] },
      quotes: {
        countsByStatus: { draft: 0, sent: input.sentQuotes, accepted: 0, declined: 0 },
        awaitingResponse: input.awaiting.map((id) => ({ id })),
        drafts: [],
      },
    },
  };
}

function passing() {
  return {
    clientId: "client-1",
    propertyId: "property-1",
    propertyClientId: "client-1" as string | null,
    projectId: "project-1",
    quoteId: "quote-1",
    quoteClientId: "client-1" as string | null,
    enquiry: {
      clientId: "client-1",
      status: "converted",
      propertyId: "property-1",
      convertedProjectId: "project-1",
    } as EnquiryObservation,
    quoteProjectId: "project-1",
    reconciledOutcome: "succeeded",
    invoiceId: "invoice-1",
    invoice: {
      clientId: "client-1",
      status: "draft",
      quoteId: "quote-1",
      projectId: "project-1",
      lineItems: [{ description: "Fence", quantity: 2, unitPrice: 50 }],
    } as InvoiceObservation,
    clientDraftInvoiceIds: ["invoice-1"] as string[] | null,
    quoteLineItems: [{ description: "Fence", quantity: 2, unitPrice: 50 }] as
      { description: string; quantity: number; unitPrice: number }[] | null,
    briefBefore: readBriefCounts(
      brief({ draftInvoices: 2, sentQuotes: 4, awaiting: [] }),
      "quote-1",
    ),
    briefAfter: readBriefCounts(
      brief({ draftInvoices: 3, sentQuotes: 5, awaiting: ["quote-1", "older"] }),
      "quote-1",
    ),
    hud: {
      available: true,
      quoteRegisterReady: true,
      registerEntry: { quoteId: "quote-1", projectId: "project-1" },
    } as HudObservation,
  };
}

describe("Beez Treez workflow assessment", () => {
  it("proves the workflow only when every link in the chain holds", () => {
    const result = assessBeezTreezWorkflow(passing());
    assert.equal(result.proven, true);
    assert.deepEqual(
      Object.entries(result.checks).filter(([, ok]) => !ok),
      [],
    );
  });

  it("reads brief counts and whether this quote is awaiting a response", () => {
    assert.deepEqual(
      readBriefCounts(brief({ draftInvoices: 1, sentQuotes: 2, awaiting: ["q"] }), "q"),
      { draftInvoices: 1, sentQuotes: 2, quoteAwaitingResponse: true },
    );
    assert.deepEqual(readBriefCounts({ data: {} }, "q"), {
      draftInvoices: null,
      sentQuotes: null,
      quoteAwaitingResponse: false,
    });
  });

  const failures: Array<[string, (input: ReturnType<typeof passing>) => void]> = [
    ["recordsOwnedByClient", (input) => (input.propertyClientId = "other")],
    ["recordsOwnedByClient", (input) => (input.enquiry.clientId = "other")],
    ["recordsOwnedByClient", (input) => (input.quoteClientId = null)],
    ["recordsOwnedByClient", (input) => (input.invoice.clientId = "other")],
    ["invoiceListedAsClientDraft", (input) => (input.clientDraftInvoiceIds = [])],
    ["invoiceListedAsClientDraft", (input) => (input.clientDraftInvoiceIds = null)],
    [
      "invoiceListedAsClientDraft",
      (input) => (input.clientDraftInvoiceIds = ["invoice-1", "someone-elses"]),
    ],
    // Unrelated activity in the same window must fail, not pass on a bigger count.
    ["briefCountsDraftInvoice", (input) => (input.briefAfter.draftInvoices = 4)],
    ["briefCountsSentQuote", (input) => (input.briefAfter.sentQuotes = 6)],
    // An unreadable list never matches, even when the readable part would.
    ["invoiceCarriesQuoteLines", (input) => (input.invoice.lineItems = null)],
    ["invoiceCarriesQuoteLines", (input) => (input.quoteLineItems = null)],
    ["enquiryOnProperty", (input) => (input.enquiry.propertyId = "other")],
    ["enquiryConverted", (input) => (input.enquiry.status = "open")],
    ["enquiryLinkedToProject", (input) => (input.enquiry.convertedProjectId = "other")],
    ["enquiryLinkedToProject", (input) => (input.enquiry.convertedProjectId = null)],
    ["quoteOnProject", (input) => (input.quoteProjectId = "other")],
    ["sendReconciledSucceeded", (input) => (input.reconciledOutcome = "failed")],
    ["invoiceDraftFromQuote", (input) => (input.invoice.quoteId = "other")],
    ["invoiceOnProject", (input) => (input.invoice.projectId = "other")],
    ["invoiceCarriesQuoteLines", (input) => (input.invoice.lineItems = [])],
    [
      "invoiceCarriesQuoteLines",
      (input) => (input.invoice.lineItems = [{ description: "Fence", quantity: 2, unitPrice: 5 }]),
    ],
    [
      "invoiceCarriesQuoteLines",
      (input) =>
        (input.invoice.lineItems = [
          ...(input.invoice.lineItems ?? []),
          { description: "Extra", quantity: 1, unitPrice: 1 },
        ]),
    ],
    // Two empty lists must never count as "the same lines".
    [
      "invoiceCarriesQuoteLines",
      (input) => {
        input.invoice.lineItems = [];
        input.quoteLineItems = [];
      },
    ],
    ["briefCountsDraftInvoice", (input) => (input.briefAfter.draftInvoices = 2)],
    ["briefCountsSentQuote", (input) => (input.briefAfter.sentQuotes = 4)],
    [
      "briefShowsQuoteAwaitingResponse",
      (input) => (input.briefAfter.quoteAwaitingResponse = false),
    ],
    ["hudShowsQuoteOnProject", (input) => (input.hud.registerEntry = null)],
    ["hudShowsQuoteOnProject", (input) => (input.hud.quoteRegisterReady = false)],
  ];
  for (const [check, breakIt] of failures) {
    it(`fails ${check} when that link is broken`, () => {
      const input = passing();
      breakIt(input);
      const result = assessBeezTreezWorkflow(input);
      assert.equal(result.checks[check as keyof typeof result.checks], false);
      assert.equal(result.proven, false);
    });
  }

  it("treats a line-item list with any malformed entry as unreadable", () => {
    const good = { description: "Fence", quantity: 2, unitPrice: 50 };
    assert.deepEqual(lineItemsFrom([good]), [good]);
    assert.equal(lineItemsFrom([good, "bad"]), null);
    assert.equal(lineItemsFrom([good, { description: "x", quantity: "1", unitPrice: 1 }]), null);
    assert.equal(lineItemsFrom(undefined), null);
    assert.deepEqual(lineItemsFrom([{ ...good, extra: "ignored" }]), [good]);
  });

  it("treats an invoice list with any entry lacking an id as unreadable", () => {
    assert.deepEqual(invoiceIdsFrom({ data: [{ id: "invoice-1" }] }), ["invoice-1"]);
    assert.deepEqual(invoiceIdsFrom({ data: [] }), []);
    assert.equal(invoiceIdsFrom({ data: [{ id: "invoice-1" }, { number: "x" }] }), null);
    assert.equal(invoiceIdsFrom({ data: [{ id: "invoice-1" }, "bad"] }), null);
    assert.equal(invoiceIdsFrom({ data: [{ id: "" }] }), null);
    assert.equal(invoiceIdsFrom({}), null);
  });

  it("never proves anything from missing brief counts", () => {
    const input = passing();
    input.briefBefore = readBriefCounts({}, "quote-1");
    input.briefAfter = readBriefCounts({}, "quote-1");
    const result = assessBeezTreezWorkflow(input);
    assert.equal(result.checks.briefCountsDraftInvoice, false);
    assert.equal(result.checks.briefCountsSentQuote, false);
    assert.equal(result.proven, false);
  });
});

describe("Commissioning mode arguments", () => {
  it("runs the plain Outlook proof by default and the workflow only on --workflow", () => {
    assert.deepEqual(commissioningModeFromArgs([]), { workflow: false });
    assert.deepEqual(commissioningModeFromArgs(["--workflow"]), { workflow: true });
  });

  it("fails a workflow run unless the whole chain was proven, naming the broken links", () => {
    const checks = assessBeezTreezWorkflow(passing()).checks;
    const evidence = (proven: boolean, broken: Partial<typeof checks> = {}) => ({
      workflow: {
        checks: { ...checks, ...broken },
        proven,
      } as never,
    });
    assert.equal(workflowFailure({ workflow: false }, {}), null);
    assert.match(workflowFailure({ workflow: true }, {}) ?? "", /no workflow evidence/);
    assert.equal(workflowFailure({ workflow: true }, evidence(true)), null);
    assert.match(
      workflowFailure({ workflow: true }, evidence(false, { hudShowsQuoteOnProject: false })) ?? "",
      /hudShowsQuoteOnProject/,
    );
  });

  it("refuses an unknown argument instead of silently ignoring it", () => {
    assert.throws(
      () => commissioningModeFromArgs(["--workflwo"]),
      /Unknown commissioning argument/,
    );
  });
});

describe("Beez Treez workflow steps", () => {
  function recorder(responses: Record<string, unknown>) {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const call: WorkflowCall = async (method, path, body) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      const key = `${method} ${path.split("?")[0]}`;
      if (!(key in responses)) throw new Error(`unexpected ${key}`);
      return responses[key];
    };
    return { calls, call };
  }

  it("creates the property, the enquiry on it, and converts it to a project", async () => {
    const { calls, call } = recorder({
      "POST /api/v1/properties": { data: { id: "property-1", clientId: "client-1" } },
      "POST /api/v1/enquiries": { data: { id: "enquiry-1" } },
      "POST /api/v1/enquiries/enquiry-1/convert-project": {
        data: { project: { id: "project-1" }, enquiry: { id: "enquiry-1" }, replayed: false },
      },
      "GET /api/v1/brief": brief({ draftInvoices: 0, sentQuotes: 0, awaiting: [] }),
    });
    const started = await startBeezTreezWorkflow({ call, clientId: "client-1", marker: "m" });
    assert.deepEqual(
      {
        propertyId: started.propertyId,
        propertyClientId: started.propertyClientId,
        enquiryId: started.enquiryId,
        projectId: started.projectId,
      },
      {
        propertyId: "property-1",
        propertyClientId: "client-1",
        enquiryId: "enquiry-1",
        projectId: "project-1",
      },
    );
    assert.deepEqual(
      calls.map((entry) => `${entry.method} ${entry.path}`),
      [
        "GET /api/v1/brief",
        "POST /api/v1/properties",
        "POST /api/v1/enquiries",
        "POST /api/v1/enquiries/enquiry-1/convert-project",
      ],
    );
    assert.equal((calls[2]?.body as { propertyId?: string }).propertyId, "property-1");
    assert.equal((calls[2]?.body as { clientId?: string }).clientId, "client-1");
  });

  it("drafts the invoice from the quote and reads the enquiry, brief and HUD afterwards", async () => {
    const { calls, call } = recorder({
      "POST /api/v1/invoices": {
        data: {
          id: "invoice-1",
          clientId: "client-1",
          status: "draft",
          quoteId: "quote-1",
          projectId: "project-1",
          lineItems: [{ description: "Line", quantity: 1, unitPrice: 1, extra: "ignored" }],
        },
      },
      "GET /api/v1/invoices": { data: [{ id: "invoice-1" }], count: 1 },
      "GET /api/v1/enquiries/enquiry-1": {
        data: {
          id: "enquiry-1",
          clientId: "client-1",
          status: "converted",
          propertyId: "property-1",
          convertedProjectId: "project-1",
        },
      },
      "GET /api/v1/brief": brief({ draftInvoices: 1, sentQuotes: 1, awaiting: ["quote-1"] }),
      "GET /api/v1/hud/snapshot": {
        quoteRegister: {
          status: "ready",
          quotes: [{ quoteId: "quote-1", projectId: "project-1" }, { quoteId: "other" }],
        },
      },
    });
    const finished = await finishBeezTreezWorkflow({
      call,
      clientId: "client-1",
      marker: "m",
      enquiryId: "enquiry-1",
      projectId: "project-1",
      quoteId: "quote-1",
      lineItems: [{ description: "Line", quantity: 1, unitPrice: 1 }],
    });
    const invoiceBody = calls[0]?.body as Record<string, unknown>;
    assert.equal(invoiceBody.quoteId, "quote-1");
    assert.equal(invoiceBody.projectId, "project-1");
    assert.deepEqual(invoiceBody.lineItems, [{ description: "Line", quantity: 1, unitPrice: 1 }]);
    assert.equal(finished.invoice.status, "draft");
    assert.equal(finished.invoice.clientId, "client-1");
    // The returned lines are read back with only the compared fields.
    assert.deepEqual(finished.invoice.lineItems, [
      { description: "Line", quantity: 1, unitPrice: 1 },
    ]);
    // The client's draft list is read from the store the brief is composed from.
    assert.equal(
      calls.find((entry) => entry.path.startsWith("/api/v1/invoices?"))?.path,
      "/api/v1/invoices?clientId=client-1&status=draft",
    );
    assert.deepEqual(finished.clientDraftInvoiceIds, ["invoice-1"]);
    assert.deepEqual(finished.enquiry, {
      clientId: "client-1",
      status: "converted",
      propertyId: "property-1",
      convertedProjectId: "project-1",
    });
    assert.equal(finished.briefAfter.quoteAwaitingResponse, true);
    assert.deepEqual(finished.hud, {
      available: true,
      quoteRegisterReady: true,
      registerEntry: { quoteId: "quote-1", projectId: "project-1" },
    });
  });

  it("reads the enquiry's project link only from the contract field convertedProjectId", async () => {
    // Regression: the first live run showed the API names it convertedProjectId.
    const { call } = recorder({
      "POST /api/v1/invoices": { data: { id: "invoice-1", status: "draft" } },
      "GET /api/v1/invoices": { data: [], count: 0 },
      "GET /api/v1/enquiries/enquiry-1": {
        data: { status: "converted", projectId: "project-1" },
      },
      "GET /api/v1/brief": brief({ draftInvoices: 1, sentQuotes: 1, awaiting: [] }),
    });
    const finished = await finishBeezTreezWorkflow({
      call,
      clientId: "client-1",
      marker: "m",
      enquiryId: "enquiry-1",
      projectId: "project-1",
      quoteId: "quote-1",
      lineItems: [],
    });
    assert.equal(finished.enquiry.convertedProjectId, null);
  });

  it("reports the HUD as unavailable rather than failing the run", async () => {
    const { call } = recorder({
      "POST /api/v1/invoices": { data: { id: "invoice-1", status: "draft" } },
      "GET /api/v1/invoices": { data: [], count: 0 },
      "GET /api/v1/enquiries/enquiry-1": { data: { status: "converted" } },
      "GET /api/v1/brief": brief({ draftInvoices: 1, sentQuotes: 1, awaiting: [] }),
    });
    const finished = await finishBeezTreezWorkflow({
      call,
      clientId: "client-1",
      marker: "m",
      enquiryId: "enquiry-1",
      projectId: "project-1",
      quoteId: "quote-1",
      lineItems: [],
    });
    assert.deepEqual(finished.hud, {
      available: false,
      quoteRegisterReady: false,
      registerEntry: null,
    });
  });
});
