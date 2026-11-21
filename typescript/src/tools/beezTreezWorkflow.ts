/**
 * The Local V1 end-to-end business workflow proof (release plan, "Business"):
 *
 *   enquiry → client → property → project/job → quote draft/edit/finalise/PDF →
 *   governed Outlook send → reconciliation → invoice draft → daily brief/HUD
 *
 * The Outlook commissioning kit owns the client, the quote and the guarded send.
 * This module adds the steps around it through the same HTTP API, then reads the
 * daily brief and the HUD snapshot back. Every check is computed from what the
 * API returned; nothing here asserts a result it did not read.
 */

/** Calls one Jarvis route and returns its body, throwing unless the status matches. */
export type WorkflowCall = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  expectedStatus?: number,
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataOf(body: unknown): Record<string, unknown> {
  return isRecord(body) && isRecord(body.data) ? body.data : {};
}

function requiredId(body: unknown, step: string): string {
  const id = dataOf(body).id;
  if (typeof id !== "string" || !id) throw new Error(`${step} response did not include an id.`);
  return id;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export type BriefCounts = {
  draftInvoices: number | null;
  sentQuotes: number | null;
  quoteAwaitingResponse: boolean;
};

/** Reads only the brief fields the proof depends on. Missing fields stay null. */
export function readBriefCounts(body: unknown, quoteId: string): BriefCounts {
  const brief = dataOf(body);
  const invoices = isRecord(brief.invoices) ? brief.invoices : {};
  const quotes = isRecord(brief.quotes) ? brief.quotes : {};
  const counts = isRecord(quotes.countsByStatus) ? quotes.countsByStatus : {};
  const awaiting = Array.isArray(quotes.awaitingResponse) ? quotes.awaitingResponse : [];
  return {
    draftInvoices: typeof invoices.draftCount === "number" ? invoices.draftCount : null,
    sentQuotes: typeof counts.sent === "number" ? counts.sent : null,
    quoteAwaitingResponse: awaiting.some((quote) => isRecord(quote) && quote.id === quoteId),
  };
}

export type HudObservation = {
  available: boolean;
  quoteRegisterReady: boolean;
  registerEntry: { quoteId: string; projectId: string | null } | null;
};

function readHud(body: unknown, quoteId: string): HudObservation {
  const register = isRecord(body) && isRecord(body.quoteRegister) ? body.quoteRegister : null;
  const quotes = register && Array.isArray(register.quotes) ? register.quotes : [];
  const entry = quotes.find((quote) => isRecord(quote) && quote.quoteId === quoteId);
  return {
    available: isRecord(body),
    quoteRegisterReady: register?.status === "ready",
    registerEntry: isRecord(entry) ? { quoteId, projectId: text(entry.projectId) } : null,
  };
}

export type WorkflowStart = {
  propertyId: string;
  /** The property's owner as the create response returned it. */
  propertyClientId: string | null;
  enquiryId: string;
  projectId: string;
  briefBefore: BriefCounts;
};

/** Brief counts first, then property → enquiry on that property → project. */
export async function startBeezTreezWorkflow(input: {
  call: WorkflowCall;
  clientId: string;
  marker: string;
}): Promise<WorkflowStart> {
  const { call, clientId, marker } = input;
  // The quote does not exist yet, so only the counts matter here.
  const briefBefore = readBriefCounts(await call("GET", "/api/v1/brief"), "");
  const property = await call(
    "POST",
    "/api/v1/properties",
    { clientId, address: `Commissioning site ${marker}`.slice(0, 500) },
    201,
  );
  const propertyId = requiredId(property, "Create property");
  const propertyClientId = text(dataOf(property).clientId);
  const enquiryId = requiredId(
    await call(
      "POST",
      "/api/v1/enquiries",
      {
        clientId,
        propertyId,
        source: "Local V1 workflow commissioning",
        requestedWork: `Disposable commissioning enquiry ${marker}`.slice(0, 2000),
        urgency: "standard",
      },
      201,
    ),
    "Create enquiry",
  );
  const converted = dataOf(
    await call(
      "POST",
      `/api/v1/enquiries/${encodeURIComponent(enquiryId)}/convert-project`,
      { title: `Commissioning job ${marker}`.slice(0, 200) },
      201,
    ),
  );
  const projectId = isRecord(converted.project) ? text(converted.project.id) : null;
  if (!projectId) throw new Error("Convert enquiry response did not include a project id.");
  return { propertyId, propertyClientId, enquiryId, projectId, briefBefore };
}

export type WorkflowLineItem = { description: string; quantity: number; unitPrice: number };

export type InvoiceObservation = {
  clientId: string | null;
  status: string | null;
  quoteId: string | null;
  projectId: string | null;
  /**
   * The invoice's line items as the API returned them, or null when the list is
   * missing or any entry is malformed. Nothing is dropped to make a match.
   */
  lineItems: WorkflowLineItem[] | null;
};

/** Every entry must be well formed, or the whole list is unreadable (null). */
export function lineItemsFrom(value: unknown): WorkflowLineItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: WorkflowLineItem[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.description !== "string" ||
      typeof item.quantity !== "number" ||
      typeof item.unitPrice !== "number"
    ) {
      return null;
    }
    items.push({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    });
  }
  return items;
}

/**
 * The ids in an invoice list response, or null when the list is missing or any
 * entry lacks a string id. Nothing is dropped, so a malformed list cannot shrink
 * into a match.
 */
export function invoiceIdsFrom(body: unknown): string[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  const ids: string[] = [];
  for (const entry of body.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) return null;
    ids.push(entry.id);
  }
  return ids;
}

function sameLineItems(
  actual: readonly WorkflowLineItem[] | null,
  expected: readonly WorkflowLineItem[] | null,
): boolean {
  return (
    actual !== null &&
    expected !== null &&
    expected.length > 0 &&
    actual.length === expected.length &&
    expected.every(
      (item, index) =>
        actual[index]?.description === item.description &&
        actual[index]?.quantity === item.quantity &&
        actual[index]?.unitPrice === item.unitPrice,
    )
  );
}

export type WorkflowFinish = {
  invoiceId: string;
  invoice: InvoiceObservation;
  /** Draft invoice ids listed for the run's disposable client, from the store the brief reads. */
  clientDraftInvoiceIds: string[] | null;
  enquiry: EnquiryObservation;
  briefAfter: BriefCounts;
  hud: HudObservation;
};

/** The enquiry as the API returns it after conversion (field names as in the contract). */
export type EnquiryObservation = {
  clientId: string | null;
  status: string | null;
  propertyId: string | null;
  convertedProjectId: string | null;
};

/** Invoice draft from the sent quote, then the enquiry, brief and HUD read back. */
export async function finishBeezTreezWorkflow(input: {
  call: WorkflowCall;
  clientId: string;
  marker: string;
  enquiryId: string;
  projectId: string;
  quoteId: string;
  lineItems: ReadonlyArray<{ description: string; quantity: number; unitPrice: number }>;
}): Promise<WorkflowFinish> {
  const { call } = input;
  const created = await call(
    "POST",
    "/api/v1/invoices",
    {
      clientId: input.clientId,
      number: `INV-${input.marker}`.slice(0, 100),
      projectId: input.projectId,
      quoteId: input.quoteId,
      lineItems: input.lineItems.map((item) => ({ ...item })),
    },
    201,
  );
  const invoiceId = requiredId(created, "Create invoice draft");
  const invoice = dataOf(created);
  const listed = await call(
    "GET",
    `/api/v1/invoices?clientId=${encodeURIComponent(input.clientId)}&status=draft`,
  );
  const clientDraftInvoiceIds = invoiceIdsFrom(listed);
  const enquiry = dataOf(
    await call("GET", `/api/v1/enquiries/${encodeURIComponent(input.enquiryId)}`),
  );
  const briefAfter = readBriefCounts(await call("GET", "/api/v1/brief"), input.quoteId);
  // An unavailable HUD is recorded as such and fails the proof; it is not a crash.
  const hudBody: unknown = await call("GET", "/api/v1/hud/snapshot").catch(() => null);
  return {
    invoiceId,
    invoice: {
      clientId: text(invoice.clientId),
      status: text(invoice.status),
      quoteId: text(invoice.quoteId),
      projectId: text(invoice.projectId),
      lineItems: lineItemsFrom(invoice.lineItems),
    },
    clientDraftInvoiceIds,
    enquiry: {
      clientId: text(enquiry.clientId),
      status: text(enquiry.status),
      propertyId: text(enquiry.propertyId),
      convertedProjectId: text(enquiry.convertedProjectId),
    },
    briefAfter,
    hud: readHud(hudBody, input.quoteId),
  };
}

export type WorkflowChecks = {
  recordsOwnedByClient: boolean;
  enquiryOnProperty: boolean;
  enquiryConverted: boolean;
  enquiryLinkedToProject: boolean;
  quoteOnProject: boolean;
  sendReconciledSucceeded: boolean;
  invoiceDraftFromQuote: boolean;
  invoiceOnProject: boolean;
  invoiceCarriesQuoteLines: boolean;
  invoiceListedAsClientDraft: boolean;
  briefCountsDraftInvoice: boolean;
  briefCountsSentQuote: boolean;
  briefShowsQuoteAwaitingResponse: boolean;
  hudShowsQuoteOnProject: boolean;
};

/**
 * Exactly one more: the run created one invoice draft and sent one quote. Any
 * other change in the same window makes this fail rather than pass on noise.
 */
function roseByExactlyOne(before: number | null, after: number | null): boolean {
  return before !== null && after !== null && after - before === 1;
}

/** Each link of the chain, read from the API; the workflow is proven only if all hold. */
export function assessBeezTreezWorkflow(input: {
  clientId: string;
  propertyId: string;
  propertyClientId: string | null;
  projectId: string;
  quoteId: string;
  quoteClientId: string | null;
  enquiry: EnquiryObservation;
  quoteProjectId: string | null;
  reconciledOutcome: string | null;
  invoiceId: string;
  invoice: InvoiceObservation;
  clientDraftInvoiceIds: readonly string[] | null;
  /** The quote's line items, which the invoice draft must carry unchanged. */
  quoteLineItems: readonly WorkflowLineItem[] | null;
  briefBefore: BriefCounts;
  briefAfter: BriefCounts;
  hud: HudObservation;
}): { checks: WorkflowChecks; proven: boolean } {
  const checks: WorkflowChecks = {
    recordsOwnedByClient: [
      input.propertyClientId,
      input.enquiry.clientId,
      input.quoteClientId,
      input.invoice.clientId,
    ].every((owner) => owner === input.clientId),
    enquiryOnProperty: input.enquiry.propertyId === input.propertyId,
    enquiryConverted: input.enquiry.status === "converted",
    enquiryLinkedToProject: input.enquiry.convertedProjectId === input.projectId,
    quoteOnProject: input.quoteProjectId === input.projectId,
    sendReconciledSucceeded: input.reconciledOutcome === "succeeded",
    invoiceDraftFromQuote:
      input.invoice.status === "draft" && input.invoice.quoteId === input.quoteId,
    invoiceOnProject: input.invoice.projectId === input.projectId,
    invoiceCarriesQuoteLines: sameLineItems(input.invoice.lineItems, input.quoteLineItems),
    // The client is disposable, so its draft list must be exactly this invoice.
    invoiceListedAsClientDraft:
      input.clientDraftInvoiceIds !== null &&
      input.clientDraftInvoiceIds.length === 1 &&
      input.clientDraftInvoiceIds[0] === input.invoiceId,
    briefCountsDraftInvoice: roseByExactlyOne(
      input.briefBefore.draftInvoices,
      input.briefAfter.draftInvoices,
    ),
    briefCountsSentQuote: roseByExactlyOne(
      input.briefBefore.sentQuotes,
      input.briefAfter.sentQuotes,
    ),
    briefShowsQuoteAwaitingResponse: input.briefAfter.quoteAwaitingResponse,
    hudShowsQuoteOnProject:
      input.hud.available &&
      input.hud.quoteRegisterReady &&
      input.hud.registerEntry?.projectId === input.projectId,
  };
  return { checks, proven: Object.values(checks).every(Boolean) };
}
