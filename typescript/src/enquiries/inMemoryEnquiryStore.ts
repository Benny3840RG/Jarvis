import type { ProjectStore } from "../projects/project.js";
import type {
  Enquiry,
  EnquiryConversionInput,
  EnquiryConversionResult,
  EnquiryInput,
  EnquiryStatus,
  EnquiryStore,
  EnquiryUpdate,
} from "./enquiry.js";
import { applyEnquiryUpdate, cloneEnquiry, createEnquiry, requiredText } from "./enquiryData.js";

export class InMemoryEnquiryStore implements EnquiryStore {
  private readonly enquiries = new Map<string, Enquiry>();

  list(filter: { status?: EnquiryStatus; clientId?: string } = {}): Promise<Enquiry[]> {
    return Promise.resolve(
      [...this.enquiries.values()]
        .filter((enquiry) => filter.status === undefined || enquiry.status === filter.status)
        .filter((enquiry) => filter.clientId === undefined || enquiry.clientId === filter.clientId)
        .map(cloneEnquiry),
    );
  }

  get(id: string): Promise<Enquiry | null> {
    const enquiry = this.enquiries.get(id);
    return Promise.resolve(enquiry ? cloneEnquiry(enquiry) : null);
  }

  add(input: EnquiryInput): Promise<Enquiry> {
    const duplicateKey = input.duplicateKey?.trim();
    if (duplicateKey) {
      const existing = [...this.enquiries.values()].find(
        (enquiry) => enquiry.duplicateKey === duplicateKey,
      );
      if (existing) return Promise.resolve(cloneEnquiry(existing));
    }
    try {
      const enquiry = createEnquiry(input);
      this.enquiries.set(enquiry.id, enquiry);
      return Promise.resolve(cloneEnquiry(enquiry));
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  update(id: string, update: EnquiryUpdate): Promise<Enquiry | null> {
    const enquiry = this.enquiries.get(id);
    if (!enquiry) return Promise.resolve(null);
    try {
      applyEnquiryUpdate(enquiry, update);
      return Promise.resolve(cloneEnquiry(enquiry));
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(id: string, reason: string): Promise<Enquiry | null> {
    const enquiry = this.enquiries.get(id);
    if (!enquiry) return Promise.resolve(null);
    if (enquiry.status !== "open") {
      return Promise.reject(new Error("Only open enquiries can be closed."));
    }
    enquiry.status = "closed";
    enquiry.closedReason = requiredText(reason, "Closed reason");
    enquiry.updatedAt = Date.now();
    return Promise.resolve(cloneEnquiry(enquiry));
  }

  async convertToProject(
    id: string,
    projects: ProjectStore,
    input: EnquiryConversionInput = {},
  ): Promise<EnquiryConversionResult | null> {
    const enquiry = this.enquiries.get(id);
    if (!enquiry) return null;
    if (enquiry.status === "converted" && enquiry.convertedProjectId) {
      const project = await projects.get(enquiry.convertedProjectId);
      if (!project) throw new Error("Converted project is unavailable.");
      return { enquiry: cloneEnquiry(enquiry), project, replayed: true };
    }
    if (enquiry.status !== "open") throw new Error("Only open enquiries can be converted.");
    const project = await projects.add({
      clientId: enquiry.clientId,
      ...(enquiry.propertyId === undefined ? {} : { propertyId: enquiry.propertyId }),
      title: input.title?.trim() || enquiry.requestedWork,
      status: "lead",
      notes:
        input.notes?.trim() ||
        [
          `Converted from enquiry ${enquiry.id}.`,
          `Source: ${enquiry.source}.`,
          enquiry.safetyNotes ? `Safety/access: ${enquiry.safetyNotes}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
    });
    enquiry.status = "converted";
    enquiry.convertedProjectId = project.id;
    enquiry.updatedAt = Date.now();
    return { enquiry: cloneEnquiry(enquiry), project, replayed: false };
  }
}
