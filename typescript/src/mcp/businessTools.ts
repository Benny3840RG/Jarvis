import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "./sdkAdapter.js";
import { z } from "zod";

import type { Enquiry } from "../enquiries/enquiry.js";
import type { Invoice } from "../invoices/invoice.js";
import type { Property } from "../properties/property.js";
import { JarvisApiError, type JarvisApiClient } from "./jarvisApiClient.js";

/**
 * Business MCP tools (issue #658): properties, enquiries and invoice drafts,
 * each a thin adapter over an existing, documented HTTP route.
 *
 * Deliberately drafting-only. Nothing here issues, voids or takes payment on an
 * invoice: those steps create official financial records, so they stay
 * owner-driven outside MCP. Quote drafting (create and edit a draft revision) is
 * exposed by `create_quote_draft`/`update_quote_draft` in `server.ts`; the rest of
 * the quote lifecycle (review, finalize, fork, send, commercial outcome) dispatches
 * or freezes official records and stays owner-driven off MCP. Every write goes
 * through the HTTP validators, so the server computes totals and enforces lifecycle
 * rules; the inputs below only pre-check shape and length to fail fast.
 */

const readAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const;

/** A write that is not safe to repeat blindly (matches the OpenAPI x-mcp-tool annotations). */
const nonIdempotentWriteAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: false,
} as const;

const createAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: false,
} as const;

const destructiveAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
  idempotentHint: true,
} as const;

const modelOnly = { ui: { visibility: ["model"] } } as const;

const id = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(2000);
const money = z.number().finite().nonnegative();
const rate = z.number().finite().min(0).max(1);

const lineItemInput = z.object({
  description: shortText,
  quantity: money,
  unitPrice: money,
});

const propertySchema = z.object({
  id: z.string(),
  clientId: z.string(),
  address: z.string(),
  hazards: z.array(z.string()),
  accessNotes: z.string().optional(),
  serviceNotes: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const enquiryStatus = z.enum(["open", "converted", "closed"]);
const enquiryUrgency = z.enum(["standard", "urgent", "emergency"]);

export const enquirySchema = z.object({
  id: z.string(),
  clientId: z.string(),
  propertyId: z.string().optional(),
  source: z.string(),
  requestedWork: z.string(),
  urgency: enquiryUrgency,
  preferredDateText: z.string().optional(),
  attachmentRefs: z.array(z.string()),
  siteNotes: z.string().optional(),
  safetyNotes: z.string().optional(),
  duplicateKey: z.string().optional(),
  status: enquiryStatus,
  convertedProjectId: z.string().optional(),
  closedReason: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const conversionProjectSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  title: z.string(),
  status: z.enum(["lead", "quoted", "active", "on_hold", "done"]),
  notes: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const invoiceStatus = z.enum(["draft", "issued", "paid", "void"]);

export const invoiceSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  projectId: z.string().optional(),
  quoteId: z.string().optional(),
  number: z.string(),
  status: invoiceStatus,
  lineItems: z.array(
    z.object({ description: z.string(), quantity: z.number(), unitPrice: z.number() }),
  ),
  subtotal: z.number(),
  taxRate: z.number().optional(),
  tax: z.number(),
  total: z.number(),
  amountPaid: z.number(),
  balanceDue: z.number(),
  paymentStatus: z.enum(["unpaid", "partial", "paid", "overpaid"]),
  dueDate: z.string().optional(),
  notes: z.string().optional(),
  duplicateKey: z.string().optional(),
  payments: z.array(
    z.object({
      id: z.string(),
      amount: z.number(),
      receivedAt: z.number(),
      method: z.string().optional(),
      reference: z.string().optional(),
      notes: z.string().optional(),
      createdAt: z.number(),
    }),
  ),
  issuedAt: z.number().optional(),
  voidedAt: z.number().optional(),
  voidReason: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

function toolError(error: unknown) {
  const message =
    error instanceof JarvisApiError
      ? `${error.message}${error.requestId ? ` Request ID: ${error.requestId}.` : ""}`
      : "Jarvis preview could not complete the request.";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function refusal(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

function text(message: string) {
  return [{ type: "text" as const, text: message }];
}

function propertyResult(property: Property, message: string) {
  return { content: text(message), structuredContent: { property } };
}

function enquiryResult(enquiry: Enquiry, message: string) {
  return { content: text(message), structuredContent: { enquiry } };
}

function invoiceResult(invoice: Invoice, message: string) {
  return { content: text(message), structuredContent: { invoice } };
}

/** Copies only the keys the caller actually supplied, so `null` (clear) survives and `undefined` is dropped. */
function supplied<T extends Record<string, unknown>>(values: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(values) as [keyof T, T[keyof T]][]) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function registerBusinessTools(server: McpServer, client: JarvisApiClient): void {
  // ---------------------------------------------------------------- properties

  registerAppTool(
    server,
    "list_properties",
    {
      title: "List client properties",
      description:
        "Use this when Benny wants to see the service properties (sites) on record, optionally for one client.",
      inputSchema: { clientId: id.optional() },
      outputSchema: { properties: z.array(propertySchema), count: z.number().int().nonnegative() },
      annotations: readAnnotations,
      _meta: modelOnly,
    },
    async ({ clientId }) => {
      try {
        const properties = await client.listProperties(supplied({ clientId }));
        return {
          content: text(`Found ${properties.length} properties.`),
          structuredContent: { properties, count: properties.length },
        };
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_property",
    {
      title: "Get a client property",
      description: "Use this when the user refers to one known property (site) by its identifier.",
      inputSchema: { propertyId: id },
      outputSchema: { property: propertySchema },
      annotations: readAnnotations,
      _meta: modelOnly,
    },
    async ({ propertyId }) => {
      try {
        return propertyResult(await client.getProperty(propertyId), "Property details.");
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_property",
    {
      title: "Add a client property",
      description:
        "Use this when the user explicitly asks to record a client's service address, with any site hazards and access or service notes.",
      inputSchema: {
        clientId: id,
        address: shortText,
        hazards: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
        accessNotes: longText.optional(),
        serviceNotes: longText.optional(),
      },
      outputSchema: { property: propertySchema },
      annotations: createAnnotations,
      _meta: modelOnly,
    },
    async (input) => {
      try {
        const created = await client.createProperty({
          clientId: input.clientId,
          address: input.address,
          ...supplied({
            hazards: input.hazards,
            accessNotes: input.accessNotes,
            serviceNotes: input.serviceNotes,
          }),
        });
        return propertyResult(created, `Added property at ${created.address}.`);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_property",
    {
      title: "Update a client property",
      description:
        "Use this when the user explicitly asks to change a property's address, hazards or notes. Pass null to clear a note.",
      inputSchema: {
        propertyId: id,
        clientId: id.optional(),
        address: shortText.optional(),
        hazards: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
        accessNotes: longText.nullable().optional(),
        serviceNotes: longText.nullable().optional(),
      },
      outputSchema: { property: propertySchema },
      annotations: writeAnnotations,
      _meta: modelOnly,
    },
    async ({ propertyId, ...fields }) => {
      try {
        const update = supplied(fields);
        if (Object.keys(update).length === 0) {
          return refusal("Property update requires at least one changed field.");
        }
        const updated = await client.updateProperty(propertyId, update);
        return propertyResult(updated, `Updated property at ${updated.address}.`);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "delete_property",
    {
      title: "Delete a client property",
      description:
        "Use this only when the user explicitly asks to permanently remove a property by identifier.",
      inputSchema: { propertyId: id },
      outputSchema: { property: propertySchema },
      annotations: destructiveAnnotations,
      _meta: modelOnly,
    },
    async ({ propertyId }) => {
      try {
        const removed = await client.deleteProperty(propertyId);
        return propertyResult(removed, `Deleted property at ${removed.address}.`);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  // ----------------------------------------------------------------- enquiries

  registerAppTool(
    server,
    "list_enquiries",
    {
      title: "List enquiries",
      description:
        "Use this when Benny wants to see incoming work enquiries, optionally filtered by status (open, converted, closed) or client.",
      inputSchema: { status: enquiryStatus.optional(), clientId: id.optional() },
      outputSchema: { enquiries: z.array(enquirySchema), count: z.number().int().nonnegative() },
      annotations: readAnnotations,
      _meta: modelOnly,
    },
    async ({ status, clientId }) => {
      try {
        const enquiries = await client.listEnquiries(supplied({ status, clientId }));
        return {
          content: text(`Found ${enquiries.length} enquiries.`),
          structuredContent: { enquiries, count: enquiries.length },
        };
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_enquiry",
    {
      title: "Get an enquiry",
      description: "Use this when the user refers to one known enquiry by its identifier.",
      inputSchema: { enquiryId: id },
      outputSchema: { enquiry: enquirySchema },
      annotations: readAnnotations,
      _meta: modelOnly,
    },
    async ({ enquiryId }) => {
      try {
        return enquiryResult(await client.getEnquiry(enquiryId), "Enquiry details.");
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_enquiry",
    {
      title: "Log an enquiry",
      description:
        "Use this when Benny reports a new work enquiry from a client. Pass a duplicateKey (for example the caller and time) so a retried log does not create a second enquiry.",
      inputSchema: {
        clientId: id,
        propertyId: id.optional(),
        source: shortText,
        requestedWork: longText,
        urgency: enquiryUrgency.optional(),
        preferredDateText: shortText.optional(),
        attachmentRefs: z.array(shortText).max(50).optional(),
        siteNotes: longText.optional(),
        safetyNotes: longText.optional(),
        duplicateKey: id.optional(),
      },
      outputSchema: { enquiry: enquirySchema },
      annotations: createAnnotations,
      _meta: modelOnly,
    },
    async ({ clientId, source, requestedWork, ...optional }) => {
      try {
        const created = await client.createEnquiry({
          clientId,
          source,
          requestedWork,
          ...supplied(optional),
        });
        return enquiryResult(created, `Logged enquiry: ${created.requestedWork}`);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_enquiry",
    {
      title: "Update an open enquiry",
      description:
        "Use this when the user explicitly asks to change an open enquiry's details. Pass null to clear an optional note or the property.",
      inputSchema: {
        enquiryId: id,
        propertyId: id.nullable().optional(),
        source: shortText.optional(),
        requestedWork: longText.optional(),
        urgency: enquiryUrgency.optional(),
        preferredDateText: shortText.nullable().optional(),
        attachmentRefs: z.array(shortText).max(50).optional(),
        siteNotes: longText.nullable().optional(),
        safetyNotes: longText.nullable().optional(),
      },
      outputSchema: { enquiry: enquirySchema },
      annotations: nonIdempotentWriteAnnotations,
      _meta: modelOnly,
    },
    async ({ enquiryId, ...fields }) => {
      try {
        const update = supplied(fields);
        if (Object.keys(update).length === 0) {
          return refusal("Enquiry update requires at least one changed field.");
        }
        return enquiryResult(await client.updateEnquiry(enquiryId, update), "Updated enquiry.");
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "close_enquiry",
    {
      title: "Close an enquiry",
      description:
        "Use this when Benny says an enquiry will not go ahead. A reason is required and the enquiry cannot then be converted.",
      inputSchema: { enquiryId: id, reason: longText },
      outputSchema: { enquiry: enquirySchema },
      annotations: nonIdempotentWriteAnnotations,
      _meta: modelOnly,
    },
    async ({ enquiryId, reason }) => {
      try {
        return enquiryResult(await client.closeEnquiry(enquiryId, reason), "Closed enquiry.");
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "convert_enquiry_to_project",
    {
      title: "Turn an enquiry into a job",
      description:
        "Use this when Benny confirms an open enquiry is going ahead. Creates a project (job) for the same client and marks the enquiry converted.",
      inputSchema: { enquiryId: id, title: shortText.optional(), notes: longText.optional() },
      outputSchema: {
        enquiry: enquirySchema,
        project: conversionProjectSchema,
        replayed: z.boolean(),
      },
      annotations: createAnnotations,
      _meta: modelOnly,
    },
    async ({ enquiryId, title, notes }) => {
      try {
        const result = await client.convertEnquiryToProject(enquiryId, supplied({ title, notes }));
        return {
          content: text(
            result.replayed
              ? `Enquiry was already converted to project "${result.project.title}".`
              : `Created project "${result.project.title}" from the enquiry.`,
          ),
          structuredContent: { ...result },
        };
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  // ------------------------------------------------------------ invoice drafts

  registerAppTool(
    server,
    "list_invoices",
    {
      title: "List invoices",
      description:
        "Use this when Benny wants to see invoices, optionally by status (draft, issued, paid, void) or client. Read-only.",
      inputSchema: { status: invoiceStatus.optional(), clientId: id.optional() },
      outputSchema: { invoices: z.array(invoiceSchema), count: z.number().int().nonnegative() },
      annotations: readAnnotations,
      _meta: modelOnly,
    },
    async ({ status, clientId }) => {
      try {
        const invoices = await client.listInvoices(supplied({ status, clientId }));
        return {
          content: text(`Found ${invoices.length} invoices.`),
          structuredContent: { invoices, count: invoices.length },
        };
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "get_invoice",
    {
      title: "Get an invoice",
      description:
        "Use this when the user refers to one known invoice by its identifier. Read-only.",
      inputSchema: { invoiceId: id },
      outputSchema: { invoice: invoiceSchema },
      annotations: readAnnotations,
      _meta: modelOnly,
    },
    async ({ invoiceId }) => {
      try {
        return invoiceResult(await client.getInvoice(invoiceId), "Invoice details.");
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_invoice_draft",
    {
      title: "Draft an invoice",
      description:
        "Use this when Benny asks to prepare an invoice. Creates a DRAFT only; Jarvis computes the totals. Issuing, voiding and recording payments are not available here.",
      inputSchema: {
        clientId: id,
        number: id,
        projectId: id.optional(),
        quoteId: id.optional(),
        lineItems: z.array(lineItemInput).max(200).optional(),
        taxRate: rate.optional(),
        dueDate: shortText.optional(),
        notes: longText.optional(),
        duplicateKey: id.optional(),
      },
      outputSchema: { invoice: invoiceSchema },
      annotations: createAnnotations,
      _meta: modelOnly,
    },
    async ({ clientId, number, ...optional }) => {
      try {
        const created = await client.createInvoiceDraft({
          clientId,
          number,
          ...supplied(optional),
        });
        return invoiceResult(created, `Drafted invoice ${created.number}, total ${created.total}.`);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "update_invoice_draft",
    {
      title: "Edit a draft invoice",
      description:
        "Use this when Benny asks to change a draft invoice. Only drafts can be edited; pass null to clear an optional field.",
      inputSchema: {
        invoiceId: id,
        number: id.optional(),
        projectId: id.nullable().optional(),
        quoteId: id.nullable().optional(),
        lineItems: z.array(lineItemInput).max(200).optional(),
        taxRate: rate.nullable().optional(),
        dueDate: shortText.nullable().optional(),
        notes: longText.nullable().optional(),
      },
      outputSchema: { invoice: invoiceSchema },
      annotations: nonIdempotentWriteAnnotations,
      _meta: modelOnly,
    },
    async ({ invoiceId, ...fields }) => {
      try {
        const update = supplied(fields);
        if (Object.keys(update).length === 0) {
          return refusal("Invoice update requires at least one changed field.");
        }
        const updated = await client.updateInvoiceDraft(invoiceId, update);
        return invoiceResult(updated, `Updated draft invoice ${updated.number}.`);
      } catch (error: unknown) {
        return toolError(error);
      }
    },
  );
}
