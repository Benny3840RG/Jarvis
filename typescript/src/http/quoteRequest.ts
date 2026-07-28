import type {
  CreateQuoteInput,
  FinalizeQuoteRevisionInput,
  ListQuotesInput,
  QuoteRevisionCommand,
  UpdateQuoteDraftInput,
} from "../quotes/quoteRepository.js";
import type {
  QuoteCommercialStatus,
  QuoteDraftPatch,
  QuoteHistoricalOutcome,
  QuoteRevisionLineItem,
} from "../quotes/quoteLifecycle.js";

const MAX_ID_LENGTH = 200;
const MAX_NUMBER_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_NOTES_LENGTH = 2000;
const MAX_VALID_UNTIL_LENGTH = 100;
const MAX_LINE_ITEMS = 200;
const MAX_LIST_LIMIT = 100;

const COMMERCIAL_STATUSES: readonly QuoteCommercialStatus[] = [
  "open",
  "accepted",
  "declined",
  "expired",
];
const HISTORICAL_OUTCOMES: readonly QuoteHistoricalOutcome[] = ["accepted", "declined", "expired"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, max = MAX_ID_LENGTH): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.trim().length > max) throw new Error(`${field} must not exceed ${max} characters.`);
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return value;
}

function taxRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Quote taxRate must be a number between 0 and 1.");
  }
  return value;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

function parseLineItems(value: unknown): QuoteRevisionLineItem[] {
  if (!Array.isArray(value)) throw new Error("Quote lineItems must be an array.");
  if (value.length === 0) throw new Error("Quote lineItems must not be empty.");
  if (value.length > MAX_LINE_ITEMS) {
    throw new Error(`Quote lineItems must not exceed ${MAX_LINE_ITEMS} entries.`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Line item ${index + 1} must be a JSON object.`);
    rejectUnknownKeys(entry, ["description", "quantity", "unitPrice"]);
    return {
      description: requiredString(
        entry.description,
        `Line item ${index + 1} description`,
        MAX_DESCRIPTION_LENGTH,
      ),
      quantity: nonNegativeNumber(entry.quantity, `Line item ${index + 1} quantity`),
      unitPrice: nonNegativeNumber(entry.unitPrice, `Line item ${index + 1} unitPrice`),
    };
  });
}

function parseCommercialStatus(value: unknown): QuoteCommercialStatus {
  if (typeof value !== "string" || !COMMERCIAL_STATUSES.includes(value as QuoteCommercialStatus)) {
    throw new Error(`commercialStatus must be one of: ${COMMERCIAL_STATUSES.join(", ")}.`);
  }
  return value as QuoteCommercialStatus;
}

function parseHistoricalOutcome(value: unknown): QuoteHistoricalOutcome {
  if (typeof value !== "string" || !HISTORICAL_OUTCOMES.includes(value as QuoteHistoricalOutcome)) {
    throw new Error(`outcome must be one of: ${HISTORICAL_OUTCOMES.join(", ")}.`);
  }
  return value as QuoteHistoricalOutcome;
}

const CREATE_ALLOWED = [
  "clientId",
  "projectId",
  "number",
  "lineItems",
  "taxRate",
  "validUntil",
  "notes",
  "termsIncluded",
] as const;

export function parseCreateQuoteRevision(body: unknown): CreateQuoteInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, CREATE_ALLOWED);
  return {
    clientId: requiredString(body.clientId, "Quote clientId"),
    ...(body.projectId === undefined
      ? {}
      : { projectId: requiredString(body.projectId, "Quote projectId") }),
    number: requiredString(body.number, "Quote number", MAX_NUMBER_LENGTH),
    lineItems: parseLineItems(body.lineItems),
    ...(body.taxRate === undefined ? {} : { taxRate: taxRate(body.taxRate) }),
    ...(body.validUntil === undefined
      ? {}
      : {
          validUntil: requiredString(body.validUntil, "Quote validUntil", MAX_VALID_UNTIL_LENGTH),
        }),
    ...(body.notes === undefined
      ? {}
      : { notes: requiredString(body.notes, "Quote notes", MAX_NOTES_LENGTH) }),
    termsIncluded:
      typeof body.termsIncluded === "boolean"
        ? body.termsIncluded
        : (() => {
            throw new Error("Quote termsIncluded must be a boolean.");
          })(),
  };
}

export function parseListQuoteRevisions(query: Record<string, unknown>): ListQuotesInput {
  const { clientId, projectId, commercialStatus, limit } = query;
  return {
    ...(clientId === undefined ? {} : { clientId: requiredString(clientId, "clientId") }),
    ...(projectId === undefined ? {} : { projectId: requiredString(projectId, "projectId") }),
    ...(commercialStatus === undefined
      ? {}
      : { commercialStatus: parseCommercialStatus(commercialStatus) }),
    ...(limit === undefined
      ? {}
      : {
          limit: (() => {
            const parsed = typeof limit === "string" ? Number(limit) : limit;
            if (
              !Number.isInteger(parsed) ||
              (parsed as number) < 1 ||
              (parsed as number) > MAX_LIST_LIMIT
            ) {
              throw new Error(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
            }
            return parsed as number;
          })(),
        }),
  };
}

function parseRevisionEnvelope(
  quoteId: string,
  revisionParam: string,
  body: unknown,
): {
  quoteId: string;
  revision: number;
  expectedAggregateVersion: number;
  expectedRevisionVersion: number;
} {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  return {
    quoteId: requiredString(quoteId, "Quote ID"),
    revision: positiveInteger(Number(revisionParam), "Revision"),
    expectedAggregateVersion: nonNegativeInteger(
      body.expectedAggregateVersion,
      "expectedAggregateVersion",
    ),
    expectedRevisionVersion: nonNegativeInteger(
      body.expectedRevisionVersion,
      "expectedRevisionVersion",
    ),
  };
}

function parsePdfParty(value: unknown, field: string): FinalizeQuoteRevisionInput["issuer"] {
  if (!isRecord(value)) throw new Error(`${field} must be a JSON object.`);
  rejectUnknownKeys(value, ["name", "abn", "email", "phone", "addressLines"]);
  const addressLines =
    value.addressLines === undefined
      ? undefined
      : Array.isArray(value.addressLines) && value.addressLines.length <= 8
        ? value.addressLines.map((line, index) =>
            requiredString(line, `${field} address line ${index + 1}`, 160),
          )
        : (() => {
            throw new Error(`${field} addressLines must be an array of at most 8 strings.`);
          })();
  return {
    name: requiredString(value.name, `${field} name`, 120),
    ...(value.abn === undefined ? {} : { abn: requiredString(value.abn, `${field} ABN`, 40) }),
    ...(value.email === undefined
      ? {}
      : { email: requiredString(value.email, `${field} email`, 320) }),
    ...(value.phone === undefined
      ? {}
      : { phone: requiredString(value.phone, `${field} phone`, 60) }),
    ...(addressLines === undefined ? {} : { addressLines }),
  };
}

export function parseQuoteFinalization(
  quoteId: string,
  revisionParam: string,
  body: unknown,
): FinalizeQuoteRevisionInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, [
    "expectedAggregateVersion",
    "expectedRevisionVersion",
    "issuer",
    "client",
  ]);
  const envelope = parseRevisionEnvelope(quoteId, revisionParam, body);
  return {
    ...envelope,
    issuer: parsePdfParty(body.issuer, "issuer"),
    client: parsePdfParty(body.client, "client"),
  };
}

export function parseQuoteRevisionCommand(
  quoteId: string,
  revisionParam: string,
  body: unknown,
): QuoteRevisionCommand {
  const envelope = parseRevisionEnvelope(quoteId, revisionParam, body);
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["expectedAggregateVersion", "expectedRevisionVersion"]);
  return envelope;
}

const DRAFT_PATCH_ALLOWED = [
  "lineItems",
  "taxRate",
  "validUntil",
  "notes",
  "termsIncluded",
] as const;

function parseDraftPatch(value: unknown): QuoteDraftPatch {
  if (!isRecord(value)) throw new Error("patch must be a JSON object.");
  rejectUnknownKeys(value, DRAFT_PATCH_ALLOWED);
  if (Object.keys(value).length === 0) {
    throw new Error("patch requires at least one changed field.");
  }
  const patch: QuoteDraftPatch = {};
  if (value.lineItems !== undefined) patch.lineItems = parseLineItems(value.lineItems);
  if (value.taxRate !== undefined)
    patch.taxRate = value.taxRate === null ? null : taxRate(value.taxRate);
  if (value.validUntil !== undefined) {
    patch.validUntil =
      value.validUntil === null
        ? null
        : requiredString(value.validUntil, "Quote validUntil", MAX_VALID_UNTIL_LENGTH);
  }
  if (value.notes !== undefined) {
    patch.notes =
      value.notes === null ? null : requiredString(value.notes, "Quote notes", MAX_NOTES_LENGTH);
  }
  if (value.termsIncluded !== undefined) {
    if (typeof value.termsIncluded !== "boolean") {
      throw new Error("Quote termsIncluded must be a boolean.");
    }
    patch.termsIncluded = value.termsIncluded;
  }
  return patch;
}

export function parseUpdateQuoteDraft(
  quoteId: string,
  revisionParam: string,
  body: unknown,
): UpdateQuoteDraftInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["expectedAggregateVersion", "expectedRevisionVersion", "patch"]);
  const envelope = parseRevisionEnvelope(quoteId, revisionParam, body);
  return { ...envelope, patch: parseDraftPatch(body.patch) };
}

export function parseForkQuoteRevision(
  quoteId: string,
  revisionParam: string,
  body: unknown,
): QuoteRevisionCommand & { expectedFingerprint: string } {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, [
    "expectedAggregateVersion",
    "expectedRevisionVersion",
    "expectedFingerprint",
  ]);
  const envelope = parseRevisionEnvelope(quoteId, revisionParam, body);
  return {
    ...envelope,
    expectedFingerprint: requiredString(body.expectedFingerprint, "expectedFingerprint"),
  };
}

export function parseRecordCommercialOutcome(
  quoteId: string,
  body: unknown,
): {
  quoteId: string;
  revision: number;
  expectedAggregateVersion: number;
  outcome: QuoteHistoricalOutcome;
} {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["revision", "expectedAggregateVersion", "outcome"]);
  return {
    quoteId: requiredString(quoteId, "Quote ID"),
    revision: positiveInteger(body.revision, "revision"),
    expectedAggregateVersion: nonNegativeInteger(
      body.expectedAggregateVersion,
      "expectedAggregateVersion",
    ),
    outcome: parseHistoricalOutcome(body.outcome),
  };
}
