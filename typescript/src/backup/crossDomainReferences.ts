import { UuidRemapper } from "./uuidRemapper.js";

/**
 * Foreign keys on the JSON business records. This is the field list a future
 * *minting* restore must pass through `UuidRemapper` after every primary id
 * has been `remap`ped or `bind`ed on that same instance.
 *
 * It is not applied today:
 * - archive v3 (`src/backup/backup.ts`) does not contain these domains;
 * - archive v4 writes the JSON business records with logical ids preserved;
 * - `notesAndEvidence` is outside both archives.
 *
 * Primary `id` is intentionally absent: the caller assigns that id. Invoice
 * `payments[].id` and enquiry `attachmentRefs` are not entity foreign keys.
 * The names match the reference checks in `src/backup/v4/businessSource.ts`.
 */
export const CROSS_DOMAIN_REFERENCE_FIELDS = {
  properties: ["clientId"],
  projects: ["clientId", "propertyId"],
  quotes: ["clientId", "projectId"],
  invoices: ["clientId", "projectId", "quoteId"],
  enquiries: ["clientId", "propertyId", "convertedProjectId"],
  errands: ["projectId"],
} as const;

export type CrossDomainRecord = keyof typeof CROSS_DOMAIN_REFERENCE_FIELDS;

/** Shallow FK rewrite for one business record. Does not restore the record. */
export function remapCrossDomainReferences<T extends Record<string, unknown>>(
  remapper: UuidRemapper,
  domain: CrossDomainRecord,
  record: T,
): T {
  return remapper.remapFields(record, CROSS_DOMAIN_REFERENCE_FIELDS[domain]);
}
