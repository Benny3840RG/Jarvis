import {
  ENQUIRY_URGENCIES,
  isEnquiryStatus,
  isEnquiryUrgency,
  type EnquiryInput,
  type EnquiryStatus,
  type EnquiryUpdate,
  type EnquiryUrgency,
  type EnquiryConversionInput,
} from "../enquiries/enquiry.js";

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 2000;
const MAX_SHORT_TEXT_LENGTH = 500;
const MAX_ATTACHMENTS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.trim().length > max) throw new Error(`${field} must not exceed ${max} characters.`);
  return value.trim();
}

function nullableString(value: unknown, field: string, max: number): string | null {
  return value === null ? null : requiredString(value, field, max);
}

function parseUrgency(value: unknown): EnquiryUrgency {
  if (!isEnquiryUrgency(value)) {
    throw new Error(`Enquiry urgency must be one of: ${ENQUIRY_URGENCIES.join(", ")}.`);
  }
  return value;
}

function parseAttachments(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Enquiry attachmentRefs must be an array.");
  if (value.length > MAX_ATTACHMENTS)
    throw new Error(`No more than ${MAX_ATTACHMENTS} attachments.`);
  return value.map((entry) => requiredString(entry, "Attachment reference", MAX_SHORT_TEXT_LENGTH));
}

const ALLOWED = [
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
] as const;

export function parseEnquiryStatus(value: unknown): EnquiryStatus | undefined {
  if (value === undefined) return undefined;
  if (!isEnquiryStatus(value)) throw new Error("Enquiry status filter is invalid.");
  return value;
}

export function parseCreateEnquiry(body: unknown): EnquiryInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  return {
    clientId: requiredString(body.clientId, "Enquiry clientId", MAX_ID_LENGTH),
    ...(body.propertyId === undefined
      ? {}
      : { propertyId: requiredString(body.propertyId, "Enquiry propertyId", MAX_ID_LENGTH) }),
    source: requiredString(body.source, "Enquiry source", MAX_SHORT_TEXT_LENGTH),
    requestedWork: requiredString(body.requestedWork, "Requested work", MAX_TEXT_LENGTH),
    ...(body.urgency === undefined ? {} : { urgency: parseUrgency(body.urgency) }),
    ...(body.preferredDateText === undefined
      ? {}
      : {
          preferredDateText: requiredString(
            body.preferredDateText,
            "Preferred date",
            MAX_SHORT_TEXT_LENGTH,
          ),
        }),
    ...(body.attachmentRefs === undefined
      ? {}
      : { attachmentRefs: parseAttachments(body.attachmentRefs) }),
    ...(body.siteNotes === undefined
      ? {}
      : { siteNotes: requiredString(body.siteNotes, "Site notes", MAX_TEXT_LENGTH) }),
    ...(body.safetyNotes === undefined
      ? {}
      : { safetyNotes: requiredString(body.safetyNotes, "Safety notes", MAX_TEXT_LENGTH) }),
    ...(body.duplicateKey === undefined
      ? {}
      : { duplicateKey: requiredString(body.duplicateKey, "Duplicate key", MAX_ID_LENGTH) }),
  };
}

export function parseUpdateEnquiry(body: unknown): EnquiryUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, [
    "propertyId",
    "source",
    "requestedWork",
    "urgency",
    "preferredDateText",
    "attachmentRefs",
    "siteNotes",
    "safetyNotes",
    "closedReason",
  ]);
  if (Object.keys(body).length === 0) {
    throw new Error("Enquiry update requires at least one changed field.");
  }
  const update: EnquiryUpdate = {};
  if (body.propertyId !== undefined)
    update.propertyId = nullableString(body.propertyId, "Enquiry propertyId", MAX_ID_LENGTH);
  if (body.source !== undefined)
    update.source = requiredString(body.source, "Enquiry source", MAX_SHORT_TEXT_LENGTH);
  if (body.requestedWork !== undefined)
    update.requestedWork = requiredString(body.requestedWork, "Requested work", MAX_TEXT_LENGTH);
  if (body.urgency !== undefined) update.urgency = parseUrgency(body.urgency);
  if (body.preferredDateText !== undefined)
    update.preferredDateText = nullableString(
      body.preferredDateText,
      "Preferred date",
      MAX_SHORT_TEXT_LENGTH,
    );
  if (body.attachmentRefs !== undefined)
    update.attachmentRefs = parseAttachments(body.attachmentRefs);
  if (body.siteNotes !== undefined)
    update.siteNotes = nullableString(body.siteNotes, "Site notes", MAX_TEXT_LENGTH);
  if (body.safetyNotes !== undefined)
    update.safetyNotes = nullableString(body.safetyNotes, "Safety notes", MAX_TEXT_LENGTH);
  if (body.closedReason !== undefined)
    update.closedReason = requiredString(body.closedReason, "Closed reason", MAX_TEXT_LENGTH);
  return update;
}

export function parseCloseEnquiry(body: unknown): string {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["reason"]);
  return requiredString(body.reason, "Closed reason", MAX_TEXT_LENGTH);
}

export function parseConvertEnquiry(body: unknown): EnquiryConversionInput {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["title", "notes"]);
  return {
    ...(body.title === undefined
      ? {}
      : { title: requiredString(body.title, "Project title", MAX_SHORT_TEXT_LENGTH) }),
    ...(body.notes === undefined
      ? {}
      : { notes: requiredString(body.notes, "Project notes", MAX_TEXT_LENGTH) }),
  };
}
