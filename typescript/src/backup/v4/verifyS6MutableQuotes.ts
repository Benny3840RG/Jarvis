import type { S4EncodedCapture } from "./s4ProjectNotes.js";
import { isDeepStrictEqual } from "node:util";
import { makeFunctionReference } from "convex/server";
import type { ConvexClientLike } from "../../persistence/convexPersistence.js";
import { ConvexQuoteRepository } from "../../quotes/convexQuoteRepository.js";
import { groupChecksum, type ArchiveVerifiedGroup } from "../archiveManifest.js";
import { parseArchiveV4 } from "./archive.js";
import { businessUnresolvedReferences } from "./businessSource.js";
import { archiveFingerprint, verifyRestoredGroups } from "./restore.js";
import { encodeS4Payload } from "./convexCapture.js";
import { readS6MutableQuotes, type S6Capture, type S6Identities } from "./s6MutableQuotes.js";

/** Existing S3 strict decoder + ordinary stores must verify the real destination before typed restore. */
export async function prepareS6MutableRestore(
  capture: S6Capture,
  archiveInput: unknown,
  destination: string,
  composedS4?: S4EncodedCapture,
) {
  const archive = parseArchiveV4(archiveInput);
  const business = archive.groups.businessRecords;
  if (!business) throw new Error("S6 requires the same archive's businessRecords payload.");
  const evidence = await verifyRestoredGroups(destination, archive);
  const businessEvidence = evidence.find((row) => row.group === "businessRecords");
  if (!businessEvidence || businessEvidence.restoredChecksum !== groupChecksum(business))
    throw new Error("S6 actual business readback evidence is missing.");
  if (businessUnresolvedReferences(business).length)
    throw new Error("S6 requires a closed business reference graph.");
  const source = readS6MutableQuotes(capture, business, composedS4);
  return {
    source,
    business,
    businessChecksum: businessEvidence.restoredChecksum,
    archiveFingerprint: archiveFingerprint(archive),
  };
}
/** Partial subset proof only; never produces quoteAggregate ArchiveVerifiedGroup coverage. */
export async function verifyRestoredS6MutableQuotes(input: {
  capture: S6Capture;
  archive: unknown;
  destination: string;
  identities: S6Identities;
  client: ConvexClientLike;
  serviceToken: string;
  approvalToken: string;
  composedS4?: { source: S4EncodedCapture; restored: S4EncodedCapture };
}) {
  const prepared = await prepareS6MutableRestore(
    input.capture,
    input.archive,
    input.destination,
    input.composedS4?.source,
  );
  const { source, business } = prepared;
  const actualCapture = (await input.client.query(
    makeFunctionReference<"query">("backupS6:capture"),
    {
      serviceToken: input.serviceToken,
      approvalToken: input.approvalToken,
      businessChecksum: prepared.businessChecksum,
    },
  )) as S6Capture;
  const actual = readS6MutableQuotes(actualCapture, business, input.composedS4?.restored);
  const restored = {
    ...actual,
    quotes: [...actual.quotes],
    quoteRevisions: [...actual.quoteRevisions],
  };
  for (const table of ["quotes", "quoteRevisions"] as const) {
    if (
      actual[table].length !== source[table].length ||
      input.identities[table].length !== source[table].length
    )
      throw new Error("S6 restored inventory mismatch.");
    const targets = new Set<string>();
    const rows = source[table].map((expected) => {
      const mapping = input.identities[table].find((row) => row.sourceId === expected._id);
      if (
        !mapping ||
        mapping.sourceCreationTime !== expected._creationTime ||
        targets.has(mapping.targetId)
      )
        throw new Error("S6 identity map mismatch.");
      targets.add(mapping.targetId);
      const row = actual[table].find((row) => row._id === mapping.targetId);
      if (!row) throw new Error("S6 restored physical identity missing.");
      return { ...row, _id: expected._id, _creationTime: expected._creationTime };
    });
    if (table === "quotes") restored.quotes = rows as typeof restored.quotes;
    else restored.quoteRevisions = rows as typeof restored.quoteRevisions;
  }
  if (!isDeepStrictEqual(source, restored))
    throw new Error("S6 restored documents differ from source.");
  const repository = new ConvexQuoteRepository({
    client: input.client,
    serviceToken: input.serviceToken,
  });
  for (const aggregate of source.quotes) {
    const revision = source.quoteRevisions.find((row) => row.quoteId === aggregate.quoteId)!;
    const { _id: aId, _creationTime: aTime, ...expectedAggregate } = aggregate;
    const { _id: rId, _creationTime: rTime, ...expectedRevision } = revision;
    const normal = await repository.getQuote(aggregate.quoteId);
    if (!isDeepStrictEqual(normal, { aggregate: expectedAggregate, revision: expectedRevision }))
      throw new Error("S6 ordinary quote read mismatch.");
    void aId;
    void aTime;
    void rId;
    void rTime;
  }
  const list = await repository.listQuotes({ limit: 100 });
  const expectedList = source.quotes.map((aggregate) => {
    const revision = source.quoteRevisions.find((row) => row.quoteId === aggregate.quoteId)!;
    return {
      quoteId: aggregate.quoteId,
      clientId: aggregate.clientId,
      ...(aggregate.projectId === undefined ? {} : { projectId: aggregate.projectId }),
      number: aggregate.number,
      currentRevision: aggregate.currentRevision,
      aggregateVersion: aggregate.aggregateVersion,
      revisionStatus: revision.status,
      commercialStatus: aggregate.commercialStatus,
      total: revision.total,
      currency: revision.currency,
      updatedAt: aggregate.updatedAt,
    };
  });
  const byId = (a: { quoteId: string }, b: { quoteId: string }) =>
    a.quoteId < b.quoteId ? -1 : a.quoteId > b.quoteId ? 1 : 0;
  if (!isDeepStrictEqual([...list].sort(byId), expectedList.sort(byId)))
    throw new Error("S6 normal quote list mismatch.");
  // Repeat S3 proof at the end; caller must keep both isolated destinations quiescent.
  await prepareS6MutableRestore(
    input.capture,
    input.archive,
    input.destination,
    input.composedS4?.source,
  );
  return {
    completeness: "partial" as const,
    verifiedGroups: [] as ArchiveVerifiedGroup[],
    sourceChecksum: encodeS4Payload(source).payloadSha256,
    restoredChecksum: encodeS4Payload(restored).payloadSha256,
    normalQuoteReads: source.quotes.length,
    businessChecksum: prepared.businessChecksum,
    archiveFingerprint: prepared.archiveFingerprint,
    captureChecksum: input.capture.payloadSha256,
  };
}
