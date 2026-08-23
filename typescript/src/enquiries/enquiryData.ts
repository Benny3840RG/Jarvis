import { randomUUID } from "node:crypto";

import type { Enquiry, EnquiryInput, EnquiryUpdate, EnquiryUrgency } from "./enquiry.js";
import { isEnquiryStatus, isEnquiryUrgency } from "./enquiry.js";

export function requiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeAttachmentRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeUrgency(value: unknown): EnquiryUrgency {
  return isEnquiryUrgency(value) ? value : "standard";
}

export function cloneEnquiry(enquiry: Enquiry): Enquiry {
  return { ...enquiry, attachmentRefs: [...enquiry.attachmentRefs] };
}

export function normalizeEnquiry(value: unknown): Enquiry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== "string" ||
    typeof input.clientId !== "string" ||
    typeof input.source !== "string" ||
    typeof input.requestedWork !== "string"
  ) {
    return null;
  }
  const createdAt = typeof input.createdAt === "number" ? input.createdAt : Date.now();
  return {
    id: input.id,
    clientId: requiredText(input.clientId, "Enquiry clientId"),
    ...(optionalText(input.propertyId) === undefined
      ? {}
      : { propertyId: optionalText(input.propertyId) }),
    source: requiredText(input.source, "Enquiry source"),
    requestedWork: requiredText(input.requestedWork, "Requested work"),
    urgency: normalizeUrgency(input.urgency),
    ...(optionalText(input.preferredDateText) === undefined
      ? {}
      : { preferredDateText: optionalText(input.preferredDateText) }),
    attachmentRefs: normalizeAttachmentRefs(input.attachmentRefs),
    ...(optionalText(input.siteNotes) === undefined
      ? {}
      : { siteNotes: optionalText(input.siteNotes) }),
    ...(optionalText(input.safetyNotes) === undefined
      ? {}
      : { safetyNotes: optionalText(input.safetyNotes) }),
    ...(optionalText(input.duplicateKey) === undefined
      ? {}
      : { duplicateKey: optionalText(input.duplicateKey) }),
    status: isEnquiryStatus(input.status) ? input.status : "open",
    ...(optionalText(input.convertedProjectId) === undefined
      ? {}
      : { convertedProjectId: optionalText(input.convertedProjectId) }),
    ...(optionalText(input.closedReason) === undefined
      ? {}
      : { closedReason: optionalText(input.closedReason) }),
    createdAt,
    updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : createdAt,
  };
}

export function createEnquiry(input: EnquiryInput): Enquiry {
  const now = Date.now();
  return {
    id: randomUUID(),
    clientId: requiredText(input.clientId, "Enquiry clientId"),
    ...(optionalText(input.propertyId) === undefined
      ? {}
      : { propertyId: optionalText(input.propertyId) }),
    source: requiredText(input.source, "Enquiry source"),
    requestedWork: requiredText(input.requestedWork, "Requested work"),
    urgency: input.urgency ?? "standard",
    ...(optionalText(input.preferredDateText) === undefined
      ? {}
      : { preferredDateText: optionalText(input.preferredDateText) }),
    attachmentRefs: normalizeAttachmentRefs(input.attachmentRefs),
    ...(optionalText(input.siteNotes) === undefined
      ? {}
      : { siteNotes: optionalText(input.siteNotes) }),
    ...(optionalText(input.safetyNotes) === undefined
      ? {}
      : { safetyNotes: optionalText(input.safetyNotes) }),
    ...(optionalText(input.duplicateKey) === undefined
      ? {}
      : { duplicateKey: optionalText(input.duplicateKey) }),
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
}

export function applyEnquiryUpdate(enquiry: Enquiry, update: EnquiryUpdate): void {
  if (
    update.propertyId === undefined &&
    update.source === undefined &&
    update.requestedWork === undefined &&
    update.urgency === undefined &&
    update.preferredDateText === undefined &&
    update.attachmentRefs === undefined &&
    update.siteNotes === undefined &&
    update.safetyNotes === undefined &&
    update.closedReason === undefined
  ) {
    throw new Error("Enquiry update requires at least one changed field.");
  }
  if (enquiry.status !== "open") throw new Error("Only open enquiries can be updated.");
  if (update.propertyId !== undefined) {
    const cleaned = update.propertyId === null ? "" : update.propertyId.trim();
    if (cleaned) enquiry.propertyId = cleaned;
    else delete enquiry.propertyId;
  }
  if (update.source !== undefined) enquiry.source = requiredText(update.source, "Enquiry source");
  if (update.requestedWork !== undefined)
    enquiry.requestedWork = requiredText(update.requestedWork, "Requested work");
  if (update.urgency !== undefined) enquiry.urgency = update.urgency;
  if (update.preferredDateText !== undefined) {
    const cleaned = update.preferredDateText === null ? "" : update.preferredDateText.trim();
    if (cleaned) enquiry.preferredDateText = cleaned;
    else delete enquiry.preferredDateText;
  }
  if (update.attachmentRefs !== undefined)
    enquiry.attachmentRefs = normalizeAttachmentRefs(update.attachmentRefs);
  if (update.siteNotes !== undefined) {
    const cleaned = update.siteNotes === null ? "" : update.siteNotes.trim();
    if (cleaned) enquiry.siteNotes = cleaned;
    else delete enquiry.siteNotes;
  }
  if (update.safetyNotes !== undefined) {
    const cleaned = update.safetyNotes === null ? "" : update.safetyNotes.trim();
    if (cleaned) enquiry.safetyNotes = cleaned;
    else delete enquiry.safetyNotes;
  }
  if (update.closedReason !== undefined)
    enquiry.closedReason = requiredText(update.closedReason, "Closed reason");
  enquiry.updatedAt = Date.now();
}
