import { isDeepStrictEqual } from "node:util";

import { JsonBusinessSettingsStore } from "../../businessSettings/jsonBusinessSettingsStore.js";
import type {
  BusinessContactDetails,
  BusinessNumberingSettings,
  BusinessPaymentDetails,
  BusinessPricingSettings,
  BusinessSettings,
} from "../../businessSettings/businessSettings.js";
import { JsonClientStore } from "../../clients/jsonClientStore.js";
import type { Client, ClientContact } from "../../clients/client.js";
import { JsonEnquiryStore } from "../../enquiries/jsonEnquiryStore.js";
import { ENQUIRY_STATUSES, ENQUIRY_URGENCIES, type Enquiry } from "../../enquiries/enquiry.js";
import { JsonErrandStore } from "../../errands/jsonErrandStore.js";
import { ERRAND_STATUSES, type Errand, type ErrandLocation } from "../../errands/errand.js";
import { JsonInvoiceStore } from "../../invoices/jsonInvoiceStore.js";
import {
  INVOICE_STATUSES,
  type Invoice,
  type InvoiceLineItem,
  type InvoicePayment,
  type InvoicePaymentStatus,
} from "../../invoices/invoice.js";
import { businessDataFiles } from "../../persistence/jarvisDataPaths.js";
import { JsonProjectStore } from "../../projects/jsonProjectStore.js";
import { PROJECT_STATUSES, type Project } from "../../projects/project.js";
import { JsonPropertyStore } from "../../properties/jsonPropertyStore.js";
import type { Property } from "../../properties/property.js";
import { JsonQuoteStore } from "../../quotes/jsonQuoteStore.js";
import { QUOTE_STATUSES, type Quote, type QuoteLineItem } from "../../quotes/quote.js";
import { sortUnresolvedReferences, type ArchiveUnresolvedReference } from "../archiveManifest.js";
import {
  assertNoUnknownKeys,
  assertRecord,
  fail,
  optional,
  strictBoolean,
  strictFiniteNumber,
  strictInteger,
  strictText,
  strictTimestamp,
  StrictBackupError,
} from "../strictValues.js";
import { readStrictArrayDocument, readStrictDocument } from "./strictDocument.js";

/**
 * Archive v4, stage 3: the business record group — clients, properties,
 * projects, quotes, invoices, enquiries, errands and business settings.
 *
 * Two properties make this group different from `core` and `memory`:
 *
 * 1. **Derived fields.** Quote and invoice totals are recomputed from line items
 *    on every read, and an invoice's `status` is partly derived from its
 *    payments. The stored values are therefore only meaningful if they agree
 *    with that derivation.
 * 2. **Unenforced references.** Nothing cascades a deletion or blocks one, so a
 *    project whose client is gone is a legal state of live data.
 *
 * Both are handled by checking rather than repairing: each domain is read once
 * strictly (a closed schema, no coercion, no defaults) and once through its own
 * ordinary store, and the two must agree exactly. That reuses the production
 * normalisation as the oracle instead of restating its rules here, so any value
 * the runtime would silently change on load fails the capture by name.
 */

const DOCUMENT_VERSION = 1;

export type BusinessRecordsPayload = {
  clients: Client[];
  properties: Property[];
  projects: Project[];
  quotes: Quote[];
  invoices: Invoice[];
  enquiries: Enquiry[];
  errands: Errand[];
  /** `null` when the settings file has never been written; the runtime then synthesises defaults. */
  businessSettings: BusinessSettings | null;
};

export type BusinessPaths = typeof businessDataFiles;

/** Fixed lock-acquisition order, extending `CAPTURE_LOCK_ORDER`'s discipline. */
export const BUSINESS_LOCK_ORDER: ReadonlyArray<keyof BusinessPaths> = [
  "clients",
  "properties",
  "projects",
  "quotes",
  "invoices",
  "enquiries",
  "errands",
  "businessSettings",
];

const CONTACT_KEYS = ["label", "value"] as const;
const CLIENT_KEYS = ["id", "name", "contacts", "notes", "createdAt", "updatedAt"] as const;
const PROPERTY_KEYS = [
  "id",
  "clientId",
  "address",
  "hazards",
  "accessNotes",
  "serviceNotes",
  "createdAt",
  "updatedAt",
] as const;
const PROJECT_KEYS = [
  "id",
  "clientId",
  "propertyId",
  "title",
  "status",
  "notes",
  "createdAt",
  "updatedAt",
] as const;
const LINE_ITEM_KEYS = ["description", "quantity", "unitPrice"] as const;
const QUOTE_KEYS = [
  "id",
  "clientId",
  "projectId",
  "number",
  "status",
  "lineItems",
  "subtotal",
  "taxRate",
  "tax",
  "total",
  "validUntil",
  "notes",
  "createdAt",
  "updatedAt",
] as const;
const PAYMENT_KEYS = [
  "id",
  "amount",
  "receivedAt",
  "method",
  "reference",
  "notes",
  "createdAt",
] as const;
const INVOICE_KEYS = [
  "id",
  "clientId",
  "projectId",
  "quoteId",
  "number",
  "status",
  "lineItems",
  "subtotal",
  "taxRate",
  "tax",
  "total",
  "amountPaid",
  "balanceDue",
  "paymentStatus",
  "dueDate",
  "notes",
  "duplicateKey",
  "payments",
  "issuedAt",
  "voidedAt",
  "voidReason",
  "createdAt",
  "updatedAt",
] as const;
const ENQUIRY_KEYS = [
  "id",
  "clientId",
  "propertyId",
  "source",
  "requestedWork",
  "urgency",
  "preferredDateText",
  "attachmentRefs",
  "siteNotes",
  "safetyNotes",
  "duplicateKey",
  "status",
  "convertedProjectId",
  "closedReason",
  "createdAt",
  "updatedAt",
] as const;
const LOCATION_KEYS = ["label", "address", "lat", "lon"] as const;
const ERRAND_KEYS = [
  "id",
  "title",
  "quantity",
  "status",
  "location",
  "projectId",
  "notes",
  "createdAt",
  "updatedAt",
  "completedAt",
] as const;
const SETTINGS_KEYS = [
  "id",
  "businessName",
  "tradingName",
  "locale",
  "timezone",
  "currency",
  "measurementSystem",
  "gstRegistered",
  "contactDetails",
  "paymentDetails",
  "pricing",
  "numbering",
  "createdAt",
  "updatedAt",
] as const;
const CONTACT_DETAIL_KEYS = ["phone", "email", "website", "abn"] as const;
const PAYMENT_DETAIL_KEYS = [
  "bankName",
  "accountName",
  "bsb",
  "accountNumber",
  "paymentReferenceTemplate",
] as const;
const PRICING_KEYS = [
  "defaultLabourRateCents",
  "defaultTravelRateCents",
  "defaultEquipmentRateCents",
  "defaultWasteRateCents",
  "defaultMaterialsMarkupBps",
  "defaultMarginBps",
  "gstRateBps",
] as const;
const NUMBERING_KEYS = [
  "quotePrefix",
  "nextQuoteNumber",
  "invoicePrefix",
  "nextInvoiceNumber",
] as const;

/** Spreads an optional field only when it is present, so absent never becomes `undefined`. */
function present<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

function record(value: unknown, at: string, allowed: readonly string[]): Record<string, unknown> {
  const row = assertRecord(value, at);
  assertNoUnknownKeys(row, allowed, at);
  return row;
}

function parseClient(value: unknown, at: string): Client {
  const row = record(value, at, CLIENT_KEYS);
  const contacts = assertArrayOf(row.contacts, `${at}.contacts`, (entry, contactAt) => {
    const contact = record(entry, contactAt, CONTACT_KEYS);
    const label = optional(contact.label, `${contactAt}.label`, strictText);
    return {
      ...present<string>("label", label),
      value: strictText(contact.value, `${contactAt}.value`),
    } as ClientContact;
  });
  return {
    id: strictText(row.id, `${at}.id`),
    name: strictText(row.name, `${at}.name`),
    contacts,
    ...present("notes", optional(row.notes, `${at}.notes`, strictText)),
    createdAt: strictTimestamp(row.createdAt, `${at}.createdAt`),
    updatedAt: strictTimestamp(row.updatedAt, `${at}.updatedAt`),
  };
}

function parseProperty(value: unknown, at: string): Property {
  const row = record(value, at, PROPERTY_KEYS);
  const hazards = assertArrayOf(row.hazards, `${at}.hazards`, (entry, hazardAt) =>
    strictText(entry, hazardAt),
  );
  if (new Set(hazards).size !== hazards.length) {
    fail(`${at}.hazards`, "contains a duplicate hazard; the store stores a deduplicated list.");
  }
  return {
    id: strictText(row.id, `${at}.id`),
    clientId: strictText(row.clientId, `${at}.clientId`),
    address: strictText(row.address, `${at}.address`),
    hazards,
    ...present("accessNotes", optional(row.accessNotes, `${at}.accessNotes`, strictText)),
    ...present("serviceNotes", optional(row.serviceNotes, `${at}.serviceNotes`, strictText)),
    createdAt: strictTimestamp(row.createdAt, `${at}.createdAt`),
    updatedAt: strictTimestamp(row.updatedAt, `${at}.updatedAt`),
  };
}

function parseProject(value: unknown, at: string): Project {
  const row = record(value, at, PROJECT_KEYS);
  return {
    id: strictText(row.id, `${at}.id`),
    clientId: strictText(row.clientId, `${at}.clientId`),
    ...present("propertyId", optional(row.propertyId, `${at}.propertyId`, strictText)),
    title: strictText(row.title, `${at}.title`),
    status: strictEnumValue(row.status, PROJECT_STATUSES, `${at}.status`),
    ...present("notes", optional(row.notes, `${at}.notes`, strictText)),
    createdAt: strictTimestamp(row.createdAt, `${at}.createdAt`),
    updatedAt: strictTimestamp(row.updatedAt, `${at}.updatedAt`),
  };
}

function parseLineItem(value: unknown, at: string): QuoteLineItem & InvoiceLineItem {
  const row = record(value, at, LINE_ITEM_KEYS);
  return {
    description: strictText(row.description, `${at}.description`),
    quantity: nonNegative(row.quantity, `${at}.quantity`),
    unitPrice: nonNegative(row.unitPrice, `${at}.unitPrice`),
  };
}

function parseQuote(value: unknown, at: string): Quote {
  const row = record(value, at, QUOTE_KEYS);
  return {
    id: strictText(row.id, `${at}.id`),
    clientId: strictText(row.clientId, `${at}.clientId`),
    ...present("projectId", optional(row.projectId, `${at}.projectId`, strictText)),
    number: strictText(row.number, `${at}.number`),
    status: strictEnumValue(row.status, QUOTE_STATUSES, `${at}.status`),
    lineItems: assertArrayOf(row.lineItems, `${at}.lineItems`, parseLineItem),
    subtotal: strictFiniteNumber(row.subtotal, `${at}.subtotal`),
    ...present("taxRate", optional(row.taxRate, `${at}.taxRate`, rate)),
    tax: strictFiniteNumber(row.tax, `${at}.tax`),
    total: strictFiniteNumber(row.total, `${at}.total`),
    ...present("validUntil", optional(row.validUntil, `${at}.validUntil`, strictText)),
    ...present("notes", optional(row.notes, `${at}.notes`, strictText)),
    createdAt: strictTimestamp(row.createdAt, `${at}.createdAt`),
    updatedAt: strictTimestamp(row.updatedAt, `${at}.updatedAt`),
  };
}

function parsePayment(value: unknown, at: string): InvoicePayment {
  const row = record(value, at, PAYMENT_KEYS);
  const amount = strictFiniteNumber(row.amount, `${at}.amount`);
  if (amount <= 0) fail(`${at}.amount`, "must be greater than zero.");
  return {
    id: strictText(row.id, `${at}.id`),
    amount,
    receivedAt: strictTimestamp(row.receivedAt, `${at}.receivedAt`),
    ...present("method", optional(row.method, `${at}.method`, strictText)),
    ...present("reference", optional(row.reference, `${at}.reference`, strictText)),
    ...present("notes", optional(row.notes, `${at}.notes`, strictText)),
    createdAt: strictTimestamp(row.createdAt, `${at}.createdAt`),
  };
}

function parseInvoice(value: unknown, at: string): Invoice {
  const row = record(value, at, INVOICE_KEYS);
  return {
    id: strictText(row.id, `${at}.id`),
    clientId: strictText(row.clientId, `${at}.clientId`),
    ...present("projectId", optional(row.projectId, `${at}.projectId`, strictText)),
    ...present("quoteId", optional(row.quoteId, `${at}.quoteId`, strictText)),
    number: strictText(row.number, `${at}.number`),
    status: strictEnumValue(row.status, INVOICE_STATUSES, `${at}.status`),
    lineItems: assertArrayOf(row.lineItems, `${at}.lineItems`, parseLineItem),
    subtotal: strictFiniteNumber(row.subtotal, `${at}.subtotal`),
    ...present("taxRate", optional(row.taxRate, `${at}.taxRate`, rate)),
    tax: strictFiniteNumber(row.tax, `${at}.tax`),
    total: strictFiniteNumber(row.total, `${at}.total`),
    amountPaid: strictFiniteNumber(row.amountPaid, `${at}.amountPaid`),
    balanceDue: strictFiniteNumber(row.balanceDue, `${at}.balanceDue`),
    paymentStatus: strictEnumValue(
      row.paymentStatus,
      ["unpaid", "partial", "paid", "overpaid"] as const satisfies readonly InvoicePaymentStatus[],
      `${at}.paymentStatus`,
    ),
    ...present("dueDate", optional(row.dueDate, `${at}.dueDate`, strictText)),
    ...present("notes", optional(row.notes, `${at}.notes`, strictText)),
    ...present("duplicateKey", optional(row.duplicateKey, `${at}.duplicateKey`, strictText)),
    payments: assertArrayOf(row.payments, `${at}.payments`, parsePayment),
    ...present("issuedAt", optional(row.issuedAt, `${at}.issuedAt`, strictTimestamp)),
    ...present("voidedAt", optional(row.voidedAt, `${at}.voidedAt`, strictTimestamp)),
    ...present("voidReason", optional(row.voidReason, `${at}.voidReason`, strictText)),
    createdAt: strictTimestamp(row.createdAt, `${at}.createdAt`),
    updatedAt: strictTimestamp(row.updatedAt, `${at}.updatedAt`),
  };
}

function parseEnquiry(value: unknown, at: string): Enquiry {
  const row = record(value, at, ENQUIRY_KEYS);
  return {
    id: strictText(row.id, `${at}.id`),
    clientId: strictText(row.clientId, `${at}.clientId`),
    ...present("propertyId", optional(row.propertyId, `${at}.propertyId`, strictText)),
    source: strictText(row.source, `${at}.source`),
    requestedWork: strictText(row.requestedWork, `${at}.requestedWork`),
    urgency: strictEnumValue(row.urgency, ENQUIRY_URGENCIES, `${at}.urgency`),
    ...present(
      "preferredDateText",
      optional(row.preferredDateText, `${at}.preferredDateText`, strictText),
    ),
    attachmentRefs: assertArrayOf(row.attachmentRefs, `${at}.attachmentRefs`, (entry, refAt) =>
      strictText(entry, refAt),
    ),
    ...present("siteNotes", optional(row.siteNotes, `${at}.siteNotes`, strictText)),
    ...present("safetyNotes", optional(row.safetyNotes, `${at}.safetyNotes`, strictText)),
    ...present("duplicateKey", optional(row.duplicateKey, `${at}.duplicateKey`, strictText)),
    status: strictEnumValue(row.status, ENQUIRY_STATUSES, `${at}.status`),
    ...present(
      "convertedProjectId",
      optional(row.convertedProjectId, `${at}.convertedProjectId`, strictText),
    ),
    ...present("closedReason", optional(row.closedReason, `${at}.closedReason`, strictText)),
    createdAt: strictTimestamp(row.createdAt, `${at}.createdAt`),
    updatedAt: strictTimestamp(row.updatedAt, `${at}.updatedAt`),
  };
}

function parseErrandLocation(value: unknown, at: string): ErrandLocation {
  const row = record(value, at, LOCATION_KEYS);
  const lat = optional(row.lat, `${at}.lat`, strictFiniteNumber);
  const lon = optional(row.lon, `${at}.lon`, strictFiniteNumber);
  if ((lat === undefined) !== (lon === undefined)) {
    fail(at, "must carry lat and lon together or not at all.");
  }
  return {
    label: strictText(row.label, `${at}.label`),
    ...present("address", optional(row.address, `${at}.address`, strictText)),
    ...present("lat", lat),
    ...present("lon", lon),
  };
}

function parseErrand(value: unknown, at: string): Errand {
  const row = record(value, at, ERRAND_KEYS);
  return {
    id: strictText(row.id, `${at}.id`),
    title: strictText(row.title, `${at}.title`),
    ...present("quantity", optional(row.quantity, `${at}.quantity`, strictFiniteNumber)),
    status: strictEnumValue(row.status, ERRAND_STATUSES, `${at}.status`),
    ...present(
      "location",
      optional(row.location, `${at}.location`, (entry, locationAt) =>
        parseErrandLocation(entry, locationAt),
      ),
    ),
    ...present("projectId", optional(row.projectId, `${at}.projectId`, strictText)),
    ...present("notes", optional(row.notes, `${at}.notes`, strictText)),
    createdAt: strictTimestamp(row.createdAt, `${at}.createdAt`),
    updatedAt: strictTimestamp(row.updatedAt, `${at}.updatedAt`),
    ...present("completedAt", optional(row.completedAt, `${at}.completedAt`, strictTimestamp)),
  };
}

function optionalTextGroup(
  value: unknown,
  at: string,
  allowed: readonly string[],
): Record<string, string> {
  const row = record(value, at, allowed);
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const entry = optional(row[key], `${at}.${key}`, strictText);
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

function parseBusinessSettings(value: unknown, at: string): BusinessSettings {
  const row = record(value, at, SETTINGS_KEYS);
  const pricingRow = record(row.pricing, `${at}.pricing`, PRICING_KEYS);
  const numberingRow = record(row.numbering, `${at}.numbering`, NUMBERING_KEYS);
  const pricing = {} as unknown as BusinessPricingSettings;
  for (const key of PRICING_KEYS) {
    (pricing as unknown as Record<string, number>)[key] = strictInteger(
      pricingRow[key],
      `${at}.pricing.${key}`,
    );
  }
  const numbering: BusinessNumberingSettings = {
    quotePrefix: strictText(numberingRow.quotePrefix, `${at}.numbering.quotePrefix`),
    nextQuoteNumber: strictInteger(numberingRow.nextQuoteNumber, `${at}.numbering.nextQuoteNumber`),
    invoicePrefix: strictText(numberingRow.invoicePrefix, `${at}.numbering.invoicePrefix`),
    nextInvoiceNumber: strictInteger(
      numberingRow.nextInvoiceNumber,
      `${at}.numbering.nextInvoiceNumber`,
    ),
  };
  // Fixed by the schema and re-imposed by the store on every read, so a stored
  // value that disagrees would be silently replaced rather than recovered.
  const fixed = <T extends string>(key: string, expected: T): T => {
    if (row[key] !== expected) fail(`${at}.${key}`, `must be "${expected}".`);
    return expected;
  };
  return {
    id: fixed("id", "business-settings"),
    businessName: strictText(row.businessName, `${at}.businessName`),
    tradingName: strictText(row.tradingName, `${at}.tradingName`),
    locale: fixed("locale", "en-AU"),
    timezone: fixed("timezone", "Australia/Melbourne"),
    currency: fixed("currency", "AUD"),
    measurementSystem: fixed("measurementSystem", "metric"),
    gstRegistered: strictBoolean(row.gstRegistered, `${at}.gstRegistered`),
    contactDetails: optionalTextGroup(
      row.contactDetails,
      `${at}.contactDetails`,
      CONTACT_DETAIL_KEYS,
    ) as BusinessContactDetails,
    paymentDetails: optionalTextGroup(
      row.paymentDetails,
      `${at}.paymentDetails`,
      PAYMENT_DETAIL_KEYS,
    ) as BusinessPaymentDetails,
    pricing,
    numbering,
    createdAt: strictTimestamp(row.createdAt, `${at}.createdAt`),
    updatedAt: strictTimestamp(row.updatedAt, `${at}.updatedAt`),
  };
}

function assertArrayOf<T>(
  value: unknown,
  at: string,
  parse: (entry: unknown, entryAt: string) => T,
): T[] {
  if (!Array.isArray(value)) fail(at, "must be an array.");
  return value.map((entry, index) => parse(entry, `${at}[${index}]`));
}

function strictEnumValue<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(at, `must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function nonNegative(value: unknown, at: string): number {
  const number = strictFiniteNumber(value, at);
  if (number < 0) fail(at, "must not be negative.");
  return number;
}

function rate(value: unknown, at: string): number {
  const number = strictFiniteNumber(value, at);
  if (number < 0 || number > 1) fail(at, "must be between 0 and 1.");
  return number;
}

/**
 * The oracle for losslessness. `strict` is what the archive would carry;
 * `runtime` is what an ordinary store reads from the very same file. Any
 * difference means the runtime silently changes the stored value on load — a
 * drifted quote total, an un-deduplicated hazard list, a row the store would
 * skip — so the capture fails by name instead of producing an archive that
 * cannot round-trip.
 *
 * Safe to run only *after* the strict read has accepted the file: a store's
 * `readDocument()` quarantines malformed JSON by renaming it aside, which a
 * backup must never trigger.
 */
function assertRuntimeAgreement<T>(
  domain: string,
  strict: readonly T[],
  runtime: readonly T[],
): void {
  if (strict.length !== runtime.length) {
    throw new StrictBackupError(
      `Backup source ${domain}: the strict reader found ${String(strict.length)} record(s) but the ordinary store reads ${String(runtime.length)}. The store would drop or alter records on load; refusing to capture a dataset that cannot be restored faithfully.`,
    );
  }
  for (let index = 0; index < strict.length; index += 1) {
    if (isDeepStrictEqual(strict[index], runtime[index])) continue;
    const id = (strict[index] as { id?: string } | undefined)?.id ?? `#${index}`;
    throw new StrictBackupError(
      `Backup source ${domain} record ${id} is stored in a form the ordinary store changes on load (for example a derived total that no longer matches its line items). Refusing to capture a value that would not survive a restore.`,
    );
  }
}

/**
 * References the business group cannot resolve within itself.
 *
 * Unlike builds, no business domain guards or cascades a deletion — removing a
 * client leaves its properties, projects, quotes, invoices and enquiries in
 * place, and nothing validates the id when they are created. A broken edge is
 * therefore ordinary live data, captured as-is and recorded here.
 */
export function businessUnresolvedReferences(
  payload: BusinessRecordsPayload,
): ArchiveUnresolvedReference[] {
  const ids = {
    clients: new Set(payload.clients.map((row) => row.id)),
    properties: new Set(payload.properties.map((row) => row.id)),
    projects: new Set(payload.projects.map((row) => row.id)),
    quotes: new Set(payload.quotes.map((row) => row.id)),
  };
  const unresolved: ArchiveUnresolvedReference[] = [];
  const check = <T extends { id: string }>(
    collection: string,
    rows: readonly T[],
    field: string,
    read: (row: T) => string | undefined,
    targetCollection: keyof typeof ids,
  ): void => {
    for (const row of rows) {
      const value = read(row);
      if (value === undefined || ids[targetCollection].has(value)) continue;
      unresolved.push({
        group: "businessRecords",
        collection,
        recordId: row.id,
        field,
        value,
        targetCollection,
      });
    }
  };
  check("properties", payload.properties, "clientId", (row) => row.clientId, "clients");
  check("projects", payload.projects, "clientId", (row) => row.clientId, "clients");
  check("projects", payload.projects, "propertyId", (row) => row.propertyId, "properties");
  check("quotes", payload.quotes, "clientId", (row) => row.clientId, "clients");
  check("quotes", payload.quotes, "projectId", (row) => row.projectId, "projects");
  check("invoices", payload.invoices, "clientId", (row) => row.clientId, "clients");
  check("invoices", payload.invoices, "projectId", (row) => row.projectId, "projects");
  check("invoices", payload.invoices, "quoteId", (row) => row.quoteId, "quotes");
  check("enquiries", payload.enquiries, "clientId", (row) => row.clientId, "clients");
  check("enquiries", payload.enquiries, "propertyId", (row) => row.propertyId, "properties");
  check(
    "enquiries",
    payload.enquiries,
    "convertedProjectId",
    (row) => row.convertedProjectId,
    "projects",
  );
  check("errands", payload.errands, "projectId", (row) => row.projectId, "projects");
  return sortUnresolvedReferences(unresolved);
}

export async function readBusinessGroup(paths: BusinessPaths): Promise<BusinessRecordsPayload> {
  const clients = await readStrictArrayDocument(
    paths.clients,
    "clients",
    DOCUMENT_VERSION,
    parseClient,
    "client",
  );
  assertRuntimeAgreement(
    "clients",
    clients,
    await new JsonClientStore(paths.clients, QUIET).list(),
  );

  const properties = await readStrictArrayDocument(
    paths.properties,
    "properties",
    DOCUMENT_VERSION,
    parseProperty,
    "property",
  );
  assertRuntimeAgreement(
    "properties",
    properties,
    await new JsonPropertyStore(paths.properties, QUIET).list(),
  );

  const projects = await readStrictArrayDocument(
    paths.projects,
    "projects",
    DOCUMENT_VERSION,
    parseProject,
    "project",
  );
  assertRuntimeAgreement(
    "projects",
    projects,
    await new JsonProjectStore(paths.projects, QUIET).list(),
  );

  const quotes = await readStrictArrayDocument(
    paths.quotes,
    "quotes",
    DOCUMENT_VERSION,
    parseQuote,
    "quote",
  );
  assertRuntimeAgreement("quotes", quotes, await new JsonQuoteStore(paths.quotes, QUIET).list());

  const invoices = await readStrictArrayDocument(
    paths.invoices,
    "invoices",
    DOCUMENT_VERSION,
    parseInvoice,
    "invoice",
  );
  assertRuntimeAgreement(
    "invoices",
    invoices,
    await new JsonInvoiceStore(paths.invoices, QUIET).list(),
  );

  const enquiries = await readStrictArrayDocument(
    paths.enquiries,
    "enquiries",
    DOCUMENT_VERSION,
    parseEnquiry,
    "enquiry",
  );
  assertRuntimeAgreement(
    "enquiries",
    enquiries,
    await new JsonEnquiryStore(paths.enquiries, QUIET).list(),
  );

  const errands = await readStrictArrayDocument(
    paths.errands,
    "errands",
    DOCUMENT_VERSION,
    parseErrand,
    "errand",
  );
  assertRuntimeAgreement(
    "errands",
    errands,
    await new JsonErrandStore(paths.errands, QUIET).list(),
  );

  const businessSettings = await readBusinessSettings(paths.businessSettings);
  if (businessSettings !== null) {
    assertRuntimeAgreement(
      "businessSettings",
      [businessSettings],
      [await new JsonBusinessSettingsStore(paths.businessSettings, QUIET).get()],
    );
  }

  return { clients, properties, projects, quotes, invoices, enquiries, errands, businessSettings };
}

const QUIET = (): void => {};

/**
 * Settings are a single object rather than a collection. `null` means the file
 * has never been written, which is a real and different state from "written
 * with default values": the store synthesises defaults on read either way, so
 * restoring nothing reproduces it exactly.
 */
async function readBusinessSettings(filePath: string): Promise<BusinessSettings | null> {
  const document = await readStrictDocument(filePath);
  if (document === null) return null;
  // The store accepts a bare settings object as well as the `{version, settings}`
  // wrapper it writes, so both are read here rather than refusing a file the
  // runtime would happily load.
  if ("settings" in document) {
    assertNoUnknownKeys(document, ["version", "settings"], `Backup source ${filePath}`);
    if (document.version !== DOCUMENT_VERSION) {
      throw new StrictBackupError(
        `Backup source ${filePath} has unsupported document version ${String(document.version)} (expected ${String(DOCUMENT_VERSION)}).`,
      );
    }
    return parseBusinessSettings(document.settings, `${filePath} settings`);
  }
  return parseBusinessSettings(document, `${filePath} settings`);
}
