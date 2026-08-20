import type { Project, ProjectStore } from "../projects/project.js";

export type EnquiryStatus = "open" | "converted" | "closed";
export type EnquiryUrgency = "standard" | "urgent" | "emergency";

export const ENQUIRY_STATUSES: readonly EnquiryStatus[] = ["open", "converted", "closed"];
export const ENQUIRY_URGENCIES: readonly EnquiryUrgency[] = ["standard", "urgent", "emergency"];

export interface Enquiry {
  id: string;
  clientId: string;
  propertyId?: string;
  source: string;
  requestedWork: string;
  urgency: EnquiryUrgency;
  preferredDateText?: string;
  attachmentRefs: string[];
  siteNotes?: string;
  safetyNotes?: string;
  duplicateKey?: string;
  status: EnquiryStatus;
  convertedProjectId?: string;
  closedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EnquiryInput {
  clientId: string;
  propertyId?: string;
  source: string;
  requestedWork: string;
  urgency?: EnquiryUrgency;
  preferredDateText?: string;
  attachmentRefs?: string[];
  siteNotes?: string;
  safetyNotes?: string;
  duplicateKey?: string;
}

export interface EnquiryUpdate {
  propertyId?: string | null;
  source?: string;
  requestedWork?: string;
  urgency?: EnquiryUrgency;
  preferredDateText?: string | null;
  attachmentRefs?: string[];
  siteNotes?: string | null;
  safetyNotes?: string | null;
  closedReason?: string;
}

export interface EnquiryConversionInput {
  title?: string;
  notes?: string;
}

export interface EnquiryConversionResult {
  enquiry: Enquiry;
  project: Project;
  replayed: boolean;
}

export interface EnquiryStore {
  list(filter?: { status?: EnquiryStatus; clientId?: string }): Promise<Enquiry[]>;
  get(id: string): Promise<Enquiry | null>;
  add(input: EnquiryInput): Promise<Enquiry>;
  update(id: string, update: EnquiryUpdate): Promise<Enquiry | null>;
  close(id: string, reason: string): Promise<Enquiry | null>;
  convertToProject(
    id: string,
    projects: ProjectStore,
    input?: EnquiryConversionInput,
  ): Promise<EnquiryConversionResult | null>;
}

export function isEnquiryStatus(value: unknown): value is EnquiryStatus {
  return typeof value === "string" && (ENQUIRY_STATUSES as readonly string[]).includes(value);
}

export function isEnquiryUrgency(value: unknown): value is EnquiryUrgency {
  return typeof value === "string" && (ENQUIRY_URGENCIES as readonly string[]).includes(value);
}
