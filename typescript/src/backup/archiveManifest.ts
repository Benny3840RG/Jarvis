import { createHash } from "node:crypto";

/**
 * Archive v4 manifest — see `typescript/docs/architecture/backup-v4-contract.md`.
 *
 * The manifest is what makes an archive's own claims checkable. Two properties
 * matter most and are enforced here rather than trusted:
 *
 * 1. `completeness` is **derived**, never asserted. Group coverage alone does
 *    not earn it: an archive is complete only once a real verification pass has
 *    restored it in isolation and re-derived every group's digest from the data
 *    read back off disk. That evidence is recorded in `verification` and
 *    re-checked here against the group checksums, so the claim is arithmetic
 *    rather than a caller's word.
 * 2. Every intentional exclusion must carry a recovery method. Recording an
 *    exclusion with no way to recover the excluded data is how a backup becomes
 *    silently incomplete, so the schema refuses it.
 */

export const V4_CONTRACT_VERSION = "jarvis-archive-v4:1" as const;

/**
 * Domain groups, in the staged order they land. Every group is *required* for a
 * complete archive: this list is the definition of "complete", so adding a group
 * here invalidates any archive that lacks it. Presence alone is not verification;
 * see `deriveCompleteness`.
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

/**
 * A reference in the captured data that points at a record the source does not
 * hold. Recorded, not repaired and not a reason to refuse the capture: several
 * domains permit deleting a referenced record (no cascade, no dependency
 * guard), so a dangling reference is a legal state of live data, and a backup
 * that refused to run on it would be useless exactly when it is needed. What
 * the archive must guarantee is that it does not *introduce* one — so this list
 * is re-derived from the restored data and compared during restore
 * verification.
 */
export type ArchiveUnresolvedReference = {
  /** Group holding the referencing record. */
  group: ArchiveGroup;
  /** Collection within that group, e.g. `buildLogs`. */
  collection: string;
  /** Id of the referencing record. */
  recordId: string;
  /** Field carrying the reference, e.g. `buildId`. */
  field: string;
  /** The id that does not resolve. */
  value: string;
  /** Collection the reference points into, e.g. `builds`. */
  targetCollection: string;
};

/**
 * The one verification method that can earn `complete`. Named and versioned so
 * that a future, stronger method is a different value rather than a silent
 * change of meaning behind the same claim.
 */
export const VERIFICATION_METHOD = "isolated-restore-readback:1" as const;

/** Per-group evidence produced by a verification pass. */
export type ArchiveVerifiedGroup = {
  group: ArchiveGroup;
  /**
   * Digest of this group re-derived from the documents read back off disk after
   * an isolated restore — not copied from the group entry. `parseManifest`
   * requires it to equal that entry's checksum, so a restore that round-trips
   * anything but the captured bytes cannot produce a matching record.
   */
  restoredChecksum: string;
};

/**
 * Evidence that this archive was actually restored and read back, which is what
 * `completeness` requires beyond group coverage.
 *
 * This record is not a proof against a determined forger — someone editing the
 * archive by hand could copy the group checksums into it. It does not need to
 * be: forging it buys nothing, because `restoreArchiveV4` re-runs the same
 * verification on every restore and fails loudly. What the record rules out is
 * the failure that matters here — tooling that declares an archive recoverable
 * without ever having restored it.
 */
export type ArchiveVerification = {
  /** When the verification pass ran. */
  verifiedAt: string;
  method: typeof VERIFICATION_METHOD;
  /** Evidence per group, one entry per group the archive carries. */
  groups: ArchiveVerifiedGroup[];
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
  /**
   * References the source itself could not resolve. Does not affect
   * `completeness`, which describes group coverage, not the source's own
   * consistency.
   */
  unresolvedReferences: ArchiveUnresolvedReference[];
  /**
   * Evidence of an isolated restore-and-read-back pass, or `null` when the
   * archive has never been verified. An archive written before verification ran
   * carries `null` and is therefore partial — which is the honest state, not a
   * defect.
   */
  verification: ArchiveVerification | null;
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

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail(`${field} must be a SHA-256 digest (sha256: followed by 64 lowercase hex characters).`);
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
 * The single definition of completeness, and the only place that may return
 * `complete`.
 *
 * Three things must hold, in order. Every required group is present; every
 * asserted cross-group dependency has both endpoints present, since a reference
 * into an absent group cannot be restored; and a verification pass has actually
 * restored the archive in isolation and re-derived a digest for every required
 * group from the data it read back.
 *
 * The third condition is the one that keeps this honest. Coverage is a claim the
 * capture makes about itself; verification is a claim only a completed restore
 * can make. There is deliberately no parameter by which a caller can assert the
 * result — the evidence is checked against the group checksums in
 * `parseManifest`, and a caller who has not run a restore has nothing to pass.
 */
export function deriveCompleteness(
  present: readonly ArchiveGroup[],
  dependencies: readonly ArchiveDependency[],
  verification: ArchiveVerification | null,
): ArchiveCompleteness {
  const have = new Set(present);
  for (const required of ARCHIVE_GROUPS) {
    if (!have.has(required)) return "partial";
  }
  for (const dependency of dependencies) {
    if (!have.has(dependency.from) || !have.has(dependency.to)) return "partial";
  }
  if (verification === null) return "partial";
  const verified = new Set(verification.groups.map((entry) => entry.group));
  for (const required of ARCHIVE_GROUPS) {
    if (!verified.has(required)) return "partial";
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
  unresolvedReferences?: ArchiveUnresolvedReference[];
  /**
   * Evidence from a completed isolated restore. Omitted by a plain capture,
   * which has not verified anything yet.
   */
  verification?: ArchiveVerification | null;
};

export function buildManifest(input: BuildManifestInput): ArchiveManifest {
  const present = input.groups.map((entry) => entry.group);
  const duplicates = present.filter((entry, index) => present.indexOf(entry) !== index);
  if (duplicates.length > 0) {
    fail(`manifest.groups repeats group "${duplicates[0]}".`);
  }
  const dependencies = input.dependencies ?? [];
  const verification = input.verification ?? null;
  if (verification !== null) {
    assertVerificationMatchesGroups(verification, input.groups);
  }
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
    unresolvedReferences: sortUnresolvedReferences(input.unresolvedReferences ?? []),
    verification,
    completeness: deriveCompleteness(present, dependencies, verification),
  };
}

/**
 * Ties the evidence to the payload it claims to be evidence for. Every verified
 * group must be one this archive carries, must appear once, and must carry the
 * digest that group's own entry carries. A verification pass over different
 * bytes — or over a group the archive does not hold — is rejected rather than
 * quietly counted toward completeness.
 */
function assertVerificationMatchesGroups(
  verification: ArchiveVerification,
  groups: readonly ArchiveGroupEntry[],
): void {
  const seen = new Set<ArchiveGroup>();
  for (const entry of verification.groups) {
    if (seen.has(entry.group)) {
      fail(`manifest.verification.groups repeats group "${entry.group}".`);
    }
    seen.add(entry.group);
    const carried = groups.find((candidate) => candidate.group === entry.group);
    if (carried === undefined) {
      fail(
        `manifest.verification.groups names group "${entry.group}", which the archive does not carry.`,
      );
    }
    if (carried.checksum !== entry.restoredChecksum) {
      fail(
        `manifest.verification.groups[${entry.group}].restoredChecksum is ${entry.restoredChecksum}, ` +
          `but the group checksum is ${carried.checksum}: the restored data is not what was captured.`,
      );
    }
  }
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
    checksum: digest(value.checksum, `${field}.checksum`),
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
    digest: digest(value.digest, `${field}.digest`),
    byteLength: nonNegativeInteger(value.byteLength, `${field}.byteLength`),
  };
}

function parseUnresolvedReference(value: unknown, index: number): ArchiveUnresolvedReference {
  const field = `manifest.unresolvedReferences[${index}]`;
  if (!isRecord(value)) fail(`${field} must be an object.`);
  assertNoUnknownKeys(
    value,
    ["group", "collection", "recordId", "field", "value", "targetCollection"],
    field,
  );
  return {
    group: group(value.group, `${field}.group`),
    collection: text(value.collection, `${field}.collection`),
    recordId: text(value.recordId, `${field}.recordId`),
    field: text(value.field, `${field}.field`),
    value: text(value.value, `${field}.value`),
    targetCollection: text(value.targetCollection, `${field}.targetCollection`),
  };
}

/**
 * Total order, so two captures of the same data produce byte-identical lists and
 * a re-derived list can be compared directly against the manifest's.
 */
export function sortUnresolvedReferences(
  entries: readonly ArchiveUnresolvedReference[],
): ArchiveUnresolvedReference[] {
  const key = (entry: ArchiveUnresolvedReference): string =>
    [entry.group, entry.collection, entry.recordId, entry.field, entry.value].join("\u0000");
  return [...entries].sort((left, right) => (key(left) < key(right) ? -1 : 1));
}

function parseVerification(value: unknown): ArchiveVerification {
  const field = "manifest.verification";
  if (!isRecord(value)) fail(`${field} must be an object or null.`);
  assertNoUnknownKeys(value, ["verifiedAt", "method", "groups"], field);
  if (value.method !== VERIFICATION_METHOD) {
    fail(`${field}.method must be "${VERIFICATION_METHOD}".`);
  }
  const verifiedAt = text(value.verifiedAt, `${field}.verifiedAt`);
  if (Number.isNaN(Date.parse(verifiedAt))) {
    fail(`${field}.verifiedAt must be an ISO-8601 timestamp.`);
  }
  const groups = array(value.groups, `${field}.groups`).map((entry, index) => {
    const entryField = `${field}.groups[${index}]`;
    if (!isRecord(entry)) fail(`${entryField} must be an object.`);
    assertNoUnknownKeys(entry, ["group", "restoredChecksum"], entryField);
    return {
      group: group(entry.group, `${entryField}.group`),
      restoredChecksum: digest(entry.restoredChecksum, `${entryField}.restoredChecksum`),
    };
  });
  return { verifiedAt: new Date(verifiedAt).toISOString(), method: VERIFICATION_METHOD, groups };
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
      "unresolvedReferences",
      "verification",
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
  const unresolvedReferences = array(
    value.unresolvedReferences,
    "manifest.unresolvedReferences",
  ).map(parseUnresolvedReference);

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

  // Absent rather than null is accepted so archives written before verification
  // existed still parse; both mean the same thing — never verified, so partial.
  const verification =
    value.verification === undefined || value.verification === null
      ? null
      : parseVerification(value.verification);
  if (verification !== null) assertVerificationMatchesGroups(verification, groups);

  const completeness = deriveCompleteness(present, dependencies, verification);
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
    unresolvedReferences: sortUnresolvedReferences(unresolvedReferences),
    verification,
    completeness,
  };
}

/**
 * Gate for the full-recovery path. A partial archive may exist for staged
 * development; it may never be mistaken for a recovery image.
 */
export function assertRecoverable(value: unknown): void {
  // Re-parsed rather than trusted: parsing is what re-derives `completeness`
  // from the coverage and evidence actually present, so a manifest that says
  // "complete" without earning it fails here rather than being believed.
  const manifest = parseManifest(value);
  if (manifest.completeness === "complete") return;

  const absent = manifest.coverage.absent;
  const unresolved = manifest.dependencies.filter(
    (dependency) =>
      !manifest.coverage.present.includes(dependency.from) ||
      !manifest.coverage.present.includes(dependency.to),
  );
  const verified = new Set((manifest.verification?.groups ?? []).map((entry) => entry.group));
  const unverified = manifest.coverage.present.filter((entry) => !verified.has(entry));
  const reasons = [
    absent.length > 0 ? `absent required group(s): ${absent.join(", ")}` : "",
    unresolved.length > 0
      ? `dependencies into absent groups: ${unresolved.map((entry) => entry.reference).join("; ")}`
      : "",
    manifest.verification === null
      ? "the archive has never been verified by an isolated restore"
      : unverified.length > 0
        ? `verification did not cover group(s): ${unverified.join(", ")}`
        : "",
  ].filter(Boolean);
  throw new ArchiveManifestError(
    `Refusing full recovery from a partial archive — ${reasons.join(" and ")}.`,
  );
}
