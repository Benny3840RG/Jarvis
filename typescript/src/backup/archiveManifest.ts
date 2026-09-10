import { createHash } from "node:crypto";

/**
 * Archive v4 manifest — see `docs/architecture/backup-v4-contract.md`.
 *
 * The manifest is what makes an archive's own claims checkable. Two properties
 * matter most and are enforced here rather than trusted:
 *
 * 1. `completeness` is **derived**, never asserted. A manifest that declares
 *    `complete` while a required group is absent, or while a declared
 *    cross-group dependency points at an absent group, is rejected at parse
 *    time. An archive cannot lie about being a recovery image.
 * 2. Every intentional exclusion must carry a recovery method. Recording an
 *    exclusion with no way to recover the excluded data is how a backup becomes
 *    silently incomplete, so the schema refuses it.
 */

export const V4_CONTRACT_VERSION = "jarvis-archive-v4:1" as const;

/**
 * Domain groups, in the staged order they land. Every group is *required* for a
 * complete archive: this list is the definition of "complete", so adding a group
 * here correctly invalidates any previously-complete archive that lacks it.
 */
export const ARCHIVE_GROUPS = [
  "core",
  "memory",
  "businessRecords",
  "notesAndEvidence",
  "orchestration",
  "quoteAggregate",
] as const;

export type ArchiveGroup = (typeof ARCHIVE_GROUPS)[number];

export type ArchiveCompleteness = "complete" | "partial";

export type ArchiveGroupEntry = {
  group: ArchiveGroup;
  schemaVersion: number;
  /** Per-domain record counts within this group. */
  counts: Record<string, number>;
  /** Content digest of this group's payload. */
  checksum: string;
  /**
   * Whether this group was captured inside the consistent-snapshot boundary.
   * One archive wrapper does not make its contents mutually consistent, so a
   * group captured outside the boundary says so rather than being assumed
   * consistent with its siblings.
   */
  consistentSnapshot: boolean;
};

/** A cross-group reference edge this archive asserts. */
export type ArchiveDependency = {
  from: ArchiveGroup;
  to: ArchiveGroup;
  /** The concrete edge, e.g. `invoices.quoteId -> quotes.id`. */
  reference: string;
};

export type ArchiveExclusion = {
  subject: string;
  reason: string;
  /** Required and non-empty: how the excluded data is recovered without this archive. */
  recoveryMethod: string;
};

export type ArchiveBlobIndexEntry = {
  /** Logical reference that points at this blob, e.g. `quotePdfArtifacts/<artifactId>`. */
  reference: string;
  digest: string;
  byteLength: number;
};

export type ArchiveManifest = {
  contractVersion: typeof V4_CONTRACT_VERSION;
  createdAt: string;
  groups: ArchiveGroupEntry[];
  coverage: {
    required: ArchiveGroup[];
    present: ArchiveGroup[];
    absent: ArchiveGroup[];
  };
  dependencies: ArchiveDependency[];
  exclusions: ArchiveExclusion[];
  blobs: ArchiveBlobIndexEntry[];
  completeness: ArchiveCompleteness;
};

export class ArchiveManifestError extends Error {}

function fail(detail: string): never {
  throw new ArchiveManifestError(detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${field} must be a non-empty string without surrounding whitespace.`);
  }
  return value;
}

function group(value: unknown, field: string): ArchiveGroup {
  if (typeof value !== "string" || !(ARCHIVE_GROUPS as readonly string[]).includes(value)) {
    fail(`${field} must be one of: ${ARCHIVE_GROUPS.join(", ")}.`);
  }
  return value as ArchiveGroup;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${field} must be a non-negative integer.`);
  }
  return value;
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field} has an unsupported field "${key}".`);
  }
}

/**
 * The single definition of completeness. An archive is complete only when every
 * required group is present **and** every asserted cross-group dependency has
 * both endpoints present — a reference into an absent group means the archive
 * cannot restore that reference, so it is not a recovery image.
 */
export function deriveCompleteness(
  present: readonly ArchiveGroup[],
  dependencies: readonly ArchiveDependency[],
): ArchiveCompleteness {
  const have = new Set(present);
  for (const required of ARCHIVE_GROUPS) {
    if (!have.has(required)) return "partial";
  }
  for (const dependency of dependencies) {
    if (!have.has(dependency.from) || !have.has(dependency.to)) return "partial";
  }
  return "complete";
}

/** Stable digest of a JSON-serialisable payload, for a group checksum. */
export function groupChecksum(payload: unknown): string {
  const canonical = JSON.stringify(payload, (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
  return `sha256:${createHash("sha256")
    .update(canonical ?? "null")
    .digest("hex")}`;
}

export type BuildManifestInput = {
  createdAt: Date;
  groups: ArchiveGroupEntry[];
  dependencies?: ArchiveDependency[];
  exclusions?: ArchiveExclusion[];
  blobs?: ArchiveBlobIndexEntry[];
};

export function buildManifest(input: BuildManifestInput): ArchiveManifest {
  const present = input.groups.map((entry) => entry.group);
  const duplicates = present.filter((entry, index) => present.indexOf(entry) !== index);
  if (duplicates.length > 0) {
    fail(`manifest.groups repeats group "${duplicates[0]}".`);
  }
  const dependencies = input.dependencies ?? [];
  return {
    contractVersion: V4_CONTRACT_VERSION,
    createdAt: input.createdAt.toISOString(),
    groups: input.groups,
    coverage: {
      required: [...ARCHIVE_GROUPS],
      present,
      absent: ARCHIVE_GROUPS.filter((entry) => !present.includes(entry)),
    },
    dependencies,
    exclusions: input.exclusions ?? [],
    blobs: input.blobs ?? [],
    completeness: deriveCompleteness(present, dependencies),
  };
}

function parseGroupEntry(value: unknown, index: number): ArchiveGroupEntry {
  const field = `manifest.groups[${index}]`;
  if (!isRecord(value)) fail(`${field} must be an object.`);
  assertNoUnknownKeys(
    value,
    ["group", "schemaVersion", "counts", "checksum", "consistentSnapshot"],
    field,
  );
  if (!isRecord(value.counts)) fail(`${field}.counts must be an object.`);
  const counts: Record<string, number> = {};
  for (const [domain, count] of Object.entries(value.counts)) {
    counts[text(domain, `${field}.counts key`)] = nonNegativeInteger(
      count,
      `${field}.counts.${domain}`,
    );
  }
  if (typeof value.consistentSnapshot !== "boolean") {
    fail(`${field}.consistentSnapshot must be a boolean.`);
  }
  return {
    group: group(value.group, `${field}.group`),
    schemaVersion: nonNegativeInteger(value.schemaVersion, `${field}.schemaVersion`),
    counts,
    checksum: text(value.checksum, `${field}.checksum`),
    consistentSnapshot: value.consistentSnapshot,
  };
}

function parseDependency(value: unknown, index: number): ArchiveDependency {
  const field = `manifest.dependencies[${index}]`;
  if (!isRecord(value)) fail(`${field} must be an object.`);
  assertNoUnknownKeys(value, ["from", "to", "reference"], field);
  return {
    from: group(value.from, `${field}.from`),
    to: group(value.to, `${field}.to`),
    reference: text(value.reference, `${field}.reference`),
  };
}

function parseExclusion(value: unknown, index: number): ArchiveExclusion {
  const field = `manifest.exclusions[${index}]`;
  if (!isRecord(value)) fail(`${field} must be an object.`);
  assertNoUnknownKeys(value, ["subject", "reason", "recoveryMethod"], field);
  return {
    subject: text(value.subject, `${field}.subject`),
    reason: text(value.reason, `${field}.reason`),
    // Enforced, not optional: an exclusion without a recovery method is how a
    // backup becomes silently incomplete.
    recoveryMethod: text(value.recoveryMethod, `${field}.recoveryMethod`),
  };
}

function parseBlob(value: unknown, index: number): ArchiveBlobIndexEntry {
  const field = `manifest.blobs[${index}]`;
  if (!isRecord(value)) fail(`${field} must be an object.`);
  assertNoUnknownKeys(value, ["reference", "digest", "byteLength"], field);
  return {
    reference: text(value.reference, `${field}.reference`),
    digest: text(value.digest, `${field}.digest`),
    byteLength: nonNegativeInteger(value.byteLength, `${field}.byteLength`),
  };
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  return value;
}

/**
 * Strict manifest parser. Rejects a manifest whose declared `completeness`,
 * `coverage.present` or `coverage.absent` disagrees with what its `groups`
 * actually contain, so an archive cannot claim to be a recovery image it is not.
 */
export function parseManifest(value: unknown): ArchiveManifest {
  if (!isRecord(value)) fail("manifest must be an object.");
  assertNoUnknownKeys(
    value,
    [
      "contractVersion",
      "createdAt",
      "groups",
      "coverage",
      "dependencies",
      "exclusions",
      "blobs",
      "completeness",
    ],
    "manifest",
  );
  if (value.contractVersion !== V4_CONTRACT_VERSION) {
    fail(
      `manifest.contractVersion must be "${V4_CONTRACT_VERSION}", got ${String(value.contractVersion)}.`,
    );
  }
  const createdAt = text(value.createdAt, "manifest.createdAt");
  if (Number.isNaN(Date.parse(createdAt))) fail("manifest.createdAt must be a valid timestamp.");

  const groups = array(value.groups, "manifest.groups").map(parseGroupEntry);
  const present = groups.map((entry) => entry.group);
  const repeated = present.filter((entry, index) => present.indexOf(entry) !== index);
  if (repeated.length > 0) fail(`manifest.groups repeats group "${repeated[0]}".`);

  const dependencies = array(value.dependencies, "manifest.dependencies").map(parseDependency);
  const exclusions = array(value.exclusions, "manifest.exclusions").map(parseExclusion);
  const blobs = array(value.blobs, "manifest.blobs").map(parseBlob);

  if (!isRecord(value.coverage)) fail("manifest.coverage must be an object.");
  assertNoUnknownKeys(value.coverage, ["required", "present", "absent"], "manifest.coverage");
  const declaredRequired = array(value.coverage.required, "manifest.coverage.required").map(
    (entry, index) => group(entry, `manifest.coverage.required[${index}]`),
  );
  const declaredPresent = array(value.coverage.present, "manifest.coverage.present").map(
    (entry, index) => group(entry, `manifest.coverage.present[${index}]`),
  );
  const declaredAbsent = array(value.coverage.absent, "manifest.coverage.absent").map(
    (entry, index) => group(entry, `manifest.coverage.absent[${index}]`),
  );
  const sorted = (entries: readonly string[]): string => [...entries].sort().join(",");
  if (sorted(declaredRequired) !== sorted(ARCHIVE_GROUPS)) {
    fail("manifest.coverage.required must list exactly the required groups.");
  }
  if (sorted(declaredPresent) !== sorted(present)) {
    fail("manifest.coverage.present disagrees with manifest.groups.");
  }
  const expectedAbsent = ARCHIVE_GROUPS.filter((entry) => !present.includes(entry));
  if (sorted(declaredAbsent) !== sorted(expectedAbsent)) {
    fail("manifest.coverage.absent disagrees with manifest.groups.");
  }

  const completeness = deriveCompleteness(present, dependencies);
  if (value.completeness !== completeness) {
    fail(
      `manifest.completeness claims "${String(value.completeness)}" but the archive derives "${completeness}".`,
    );
  }

  return {
    contractVersion: V4_CONTRACT_VERSION,
    createdAt: new Date(createdAt).toISOString(),
    groups,
    coverage: { required: [...ARCHIVE_GROUPS], present, absent: expectedAbsent },
    dependencies,
    exclusions,
    blobs,
    completeness,
  };
}

/**
 * Gate for the full-recovery path. A partial archive may exist for staged
 * development; it may never be mistaken for a recovery image.
 */
export function assertRecoverable(manifest: ArchiveManifest): void {
  if (manifest.completeness === "complete") return;
  const absent = manifest.coverage.absent;
  const unresolved = manifest.dependencies.filter(
    (dependency) =>
      !manifest.coverage.present.includes(dependency.from) ||
      !manifest.coverage.present.includes(dependency.to),
  );
  const reasons = [
    absent.length > 0 ? `absent required group(s): ${absent.join(", ")}` : "",
    unresolved.length > 0
      ? `dependencies into absent groups: ${unresolved.map((entry) => entry.reference).join("; ")}`
      : "",
  ].filter(Boolean);
  throw new ArchiveManifestError(
    `Refusing full recovery from a partial archive — ${reasons.join(" and ")}.`,
  );
}
