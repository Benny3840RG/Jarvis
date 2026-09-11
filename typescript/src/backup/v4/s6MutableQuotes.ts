import { jsonToConvex } from "convex/values";
import type { Doc, Id } from "../../../convex/_generated/dataModel.js";
import { buildInitialQuoteRecords } from "../../../convex/quoteValidators.js";
import { canonicalJson } from "../../actions/canonicalJson.js";
import { sha256Hex } from "../../actions/sha256.js";
import type { BusinessRecordsPayload } from "./businessSource.js";
import { encodeS4Payload, S4_MAX_PAYLOAD_BYTES } from "./convexCapture.js";

export const S6_CAPTURE_VERSION = "archive-v4-s6-mutable-capture:v1";
export const S6_TABLES = [
  "quotes",
  "quoteRevisions",
  "quotePdfArtifacts",
  "quoteDeliveryAttempts",
  "quoteMigrationRecords",
  "toolActions",
  "toolExecutionReceipts",
  "externalReconciliations",
] as const;
export type S6Table = (typeof S6_TABLES)[number];
export type S6Capture = { payloadJson: string; payloadSha256: string };
export type S6Source = {
  ownerId: string;
  businessChecksum: string;
  quotes: Doc<"quotes">[];
  quoteRevisions: Doc<"quoteRevisions">[];
};
export type S6Identities = {
  [T in "quotes" | "quoteRevisions"]: Array<{
    sourceId: string;
    targetId: Id<T>;
    sourceCreationTime: number;
  }>;
};
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, fields: string[]): boolean {
  return (
    Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key))
  );
}
function clock(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4096 && value === value.trim()
  );
}
export function s6BusinessChecksum(business: BusinessRecordsPayload): string {
  return `sha256:${sha256Hex(canonicalJson(business))}`;
}
/** Logical closure only. Actual S3 filesystem proof belongs to the existing Node verifier. */
export function readS6MutableQuotes(
  capture: S6Capture,
  business: BusinessRecordsPayload,
): S6Source {
  if (
    typeof capture.payloadJson !== "string" ||
    new TextEncoder().encode(capture.payloadJson).length > S4_MAX_PAYLOAD_BYTES ||
    sha256Hex(capture.payloadJson) !== capture.payloadSha256
  )
    throw new Error("Invalid S6 payload size or checksum.");
  const decoded = jsonToConvex(JSON.parse(capture.payloadJson));
  if (encodeS4Payload(decoded).payloadJson !== capture.payloadJson)
    throw new Error("Noncanonical S6 capture.");
  if (
    !object(decoded) ||
    !keys(decoded, [
      "version",
      "provider",
      "ownerId",
      "capturedAt",
      "businessChecksum",
      "tables",
    ]) ||
    decoded.version !== S6_CAPTURE_VERSION ||
    decoded.provider !== "convex" ||
    !text(decoded.ownerId) ||
    !clock(decoded.capturedAt) ||
    !Array.isArray(decoded.tables) ||
    decoded.tables.length !== S6_TABLES.length ||
    decoded.businessChecksum !== s6BusinessChecksum(business)
  )
    throw new Error("Invalid S6 inventory or business archive binding.");
  const source: S6Source = {
    ownerId: decoded.ownerId,
    businessChecksum: decoded.businessChecksum as string,
    quotes: [],
    quoteRevisions: [],
  };
  for (let i = 0; i < S6_TABLES.length; i++) {
    const table = S6_TABLES[i]!,
      entry = decoded.tables[i];
    if (
      !object(entry) ||
      !keys(entry, ["table", "documents"]) ||
      entry.table !== table ||
      !Array.isArray(entry.documents) ||
      entry.documents.length > 100
    )
      throw new Error("Invalid S6 table inventory or bound.");
    if (table !== "quotes" && table !== "quoteRevisions") {
      if (entry.documents.length) throw new Error(`Unsupported nonempty S6 dependency: ${table}.`);
      continue;
    }
    const ids = new Set<string>();
    for (const row of entry.documents) {
      if (
        !object(row) ||
        !text(row._id) ||
        !clock(row._creationTime) ||
        row.ownerId !== source.ownerId ||
        ids.has(row._id)
      )
        throw new Error("Invalid S6 physical identity or owner.");
      ids.add(row._id);
    }
    if (table === "quotes") source.quotes = entry.documents as Doc<"quotes">[];
    else source.quoteRevisions = entry.documents as Doc<"quoteRevisions">[];
  }
  if (source.quotes.length !== source.quoteRevisions.length)
    throw new Error("S6 revision graph is not closed.");
  const clients = new Set(business.clients.map((row) => row.id));
  const projects = new Set(business.projects.map((row) => row.id));
  const quoteIds = new Set<string>(),
    numbers = new Set<string>(),
    revisionIds = new Set<string>();
  for (const aggregate of source.quotes) {
    const revision = source.quoteRevisions.find((row) => row.quoteId === aggregate.quoteId);
    if (
      !revision ||
      !text(aggregate.quoteId) ||
      !text(revision.revisionId) ||
      quoteIds.has(aggregate.quoteId) ||
      numbers.has(aggregate.number) ||
      revisionIds.has(revision.revisionId)
    )
      throw new Error("Duplicate or unresolved quote identity.");
    quoteIds.add(aggregate.quoteId);
    numbers.add(aggregate.number);
    revisionIds.add(revision.revisionId);
    if (
      !clients.has(aggregate.clientId) ||
      (aggregate.projectId !== undefined && !projects.has(aggregate.projectId))
    )
      throw new Error("Unresolved S6 business reference.");
    if (
      !clock(aggregate.createdAt) ||
      !clock(aggregate.updatedAt) ||
      aggregate.updatedAt < aggregate.createdAt ||
      !Number.isSafeInteger(aggregate.aggregateVersion) ||
      aggregate.aggregateVersion < 1 ||
      revision.revisionVersion !== aggregate.aggregateVersion ||
      revision.createdAt !== aggregate.createdAt ||
      revision.updatedAt !== aggregate.updatedAt ||
      (revision.status !== "draft" && revision.status !== "reviewed")
    )
      throw new Error("Unsupported mutable quote state, version or clock.");
    const initial = buildInitialQuoteRecords({
      ownerId: aggregate.ownerId,
      quoteId: aggregate.quoteId,
      revisionId: revision.revisionId,
      clientId: aggregate.clientId,
      ...(aggregate.projectId === undefined ? {} : { projectId: aggregate.projectId }),
      number: aggregate.number,
      lineItems: revision.lineItems,
      ...(revision.taxRate === undefined ? {} : { taxRate: revision.taxRate }),
      ...(revision.validUntil === undefined ? {} : { validUntil: revision.validUntil }),
      ...(revision.notes === undefined ? {} : { notes: revision.notes }),
      termsIncluded: revision.termsIncluded,
      now: aggregate.createdAt,
    });
    initial.aggregate.aggregateVersion = aggregate.aggregateVersion;
    initial.aggregate.updatedAt = aggregate.updatedAt;
    initial.revision.revisionVersion = revision.revisionVersion;
    initial.revision.updatedAt = revision.updatedAt;
    if (revision.status === "reviewed") {
      if (revision.revisionVersion < 2 || revision.reviewedAt !== revision.updatedAt)
        throw new Error("Invalid reviewed quote metadata.");
      initial.revision.status = "reviewed";
      initial.revision.reviewedAt = revision.reviewedAt;
    }
    if (!Number.isFinite(initial.revision.total) || typeof revision.termsIncluded !== "boolean")
      throw new Error("Invalid quote amounts or terms.");
    const { _id: aggregateId, _creationTime: aggregateTime, ...actualAggregate } = aggregate;
    const { _id: revisionId, _creationTime: revisionTime, ...actualRevision } = revision;
    // Reuse the authoritative quote builder to check normalized content/totals;
    // preserve versions and clocks verbatim, never invoke lifecycle mutations.
    if (
      canonicalJson(initial) !==
      canonicalJson({ aggregate: actualAggregate, revision: actualRevision })
    )
      throw new Error("Unsupported or inconsistent mutable quote document.");
    void aggregateId;
    void aggregateTime;
    void revisionId;
    void revisionTime;
  }
  return source;
}
