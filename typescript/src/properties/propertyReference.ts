import type { EnquiryStore } from "../enquiries/enquiry.js";
import { JarvisProblem } from "../http/problemDetails.js";
import type { ProjectStore } from "../projects/project.js";

import type { PropertyStore } from "./property.js";

function missingProperty(): JarvisProblem {
  return new JarvisProblem(
    404,
    "property-not-found",
    "Property Not Found",
    "The requested property does not exist.",
  );
}

function foreignProperty(): JarvisProblem {
  return new JarvisProblem(
    422,
    "property-client-mismatch",
    "Property Belongs To Another Client",
    "The referenced property does not belong to this client.",
  );
}

/**
 * Confirm a property exists and belongs to `clientId`. Call this on the
 * client reference lock turn, before the write that stores the reference.
 */
export async function confirmPropertyOwnedByClient(
  properties: Pick<PropertyStore, "get">,
  propertyId: string,
  clientId: string,
): Promise<void> {
  const property = await properties.get(propertyId);
  if (!property) throw missingProperty();
  if (property.clientId !== clientId) throw foreignProperty();
}

/** Records that point at a property and pin its client and its existence. */
export const PROPERTY_REFERENCE_KINDS = ["enquiry", "project"] as const;

export type PropertyReferenceKind = (typeof PROPERTY_REFERENCE_KINDS)[number];

export type PropertyReferenceStores = {
  enquiries: Pick<EnquiryStore, "list">;
  projects: Pick<ProjectStore, "list">;
};

/**
 * Names every store that still references `propertyId`. Store failures
 * propagate so the caller can fail closed.
 */
export async function findPropertyReferences(
  propertyId: string,
  stores: PropertyReferenceStores,
): Promise<PropertyReferenceKind[]> {
  const kinds: PropertyReferenceKind[] = [];
  if ((await stores.enquiries.list()).some((enquiry) => enquiry.propertyId === propertyId)) {
    kinds.push("enquiry");
  }
  if ((await stores.projects.list()).some((project) => project.propertyId === propertyId)) {
    kinds.push("project");
  }
  return kinds;
}

export function propertyStillReferenced(kinds: readonly PropertyReferenceKind[]): JarvisProblem {
  const labels = kinds.map((kind) => (kind === "enquiry" ? "an enquiry" : "a project"));
  return new JarvisProblem(
    409,
    "property-still-referenced",
    "Property Still Referenced",
    `This property is still referenced by ${labels.join(" and ")}.`,
  );
}
