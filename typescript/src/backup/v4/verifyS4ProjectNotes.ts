import { isDeepStrictEqual } from "node:util";
import { encodeS4Payload } from "./convexCapture.js";
import { makeFunctionReference } from "convex/server";
import { api } from "../../../convex/_generated/api.js";
import type { Doc } from "../../../convex/_generated/dataModel.js";
import { ConvexMemoryChangeSetService } from "../../persistence/convexMemoryChangeSets.js";
import { ConvexNoteStore } from "../../persistence/convexNotes.js";
import { ConvexTotalityJournal } from "../../persistence/convexTotalityJournal.js";
import type { ConvexClientLike } from "../../persistence/convexPersistence.js";
import {
  groupChecksum,
  VERIFICATION_METHOD,
  type ArchiveVerifiedGroup,
} from "../archiveManifest.js";
import {
  readS4ProjectNotes,
  S4_RESTORE_TABLES,
  type S4EncodedCapture,
  type S4ProjectNotesIdentities,
} from "./s4ProjectNotes.js";

/** A partial adapter check cannot issue whole notesAndEvidence coverage. */
export async function verifyRestoredS4ProjectNotes(
  capture: S4EncodedCapture,
  identities: S4ProjectNotesIdentities,
  client: ConvexClientLike,
  serviceToken: string,
  approvalToken: string,
) {
  const source = readS4ProjectNotes(capture);
  const actualCapture = (await client.query(makeFunctionReference<"query">("backupS4:capture"), {
    serviceToken,
    approvalToken,
  })) as S4EncodedCapture;
  const actual = readS4ProjectNotes(actualCapture);
  if (
    actual.ownerId !== source.ownerId ||
    S4_RESTORE_TABLES.some((table) => actual[table].length !== source[table].length)
  )
    throw new Error("S4 restored owner or count mismatch.");
  if (S4_RESTORE_TABLES.some((table) => identities[table].length !== source[table].length))
    throw new Error("S4 identity map count mismatch.");
  const restored = {
    ownerId: source.ownerId,
    projects: [] as Doc<"projects">[],
    notes: [] as Doc<"notes">[],
    projectRecords: [] as Doc<"projectRecords">[],
    memoryChangeSets: [] as Doc<"memoryChangeSets">[],
    auditEvents: [] as Doc<"auditEvents">[],
  };
  const projects = new ConvexTotalityJournal(client, serviceToken),
    notes = new ConvexNoteStore(client, serviceToken);
  const memory = new ConvexMemoryChangeSetService(client, serviceToken);
  const recordGroups = new Map<string, Doc<"projectRecords">[]>();
  const auditRequests = new Map<string, Doc<"auditEvents">[]>();
  for (const table of S4_RESTORE_TABLES) {
    if (
      !isDeepStrictEqual(
        actual[table].map((row) => row._id),
        identities[table].map((row) => row.targetId),
      )
    )
      throw new Error("S4 restored source ordering mismatch.");
    const targets = new Set<string>();
    for (let i = 0; i < source[table].length; i++) {
      const expected = source[table][i]!;
      const mapping = identities[table][i]!;
      if (
        mapping.sourceId !== expected._id ||
        mapping.sourceCreationTime !== expected._creationTime ||
        targets.has(mapping.targetId)
      )
        throw new Error("Invalid or duplicate S4 identity map.");
      targets.add(mapping.targetId);
      if (!actual[table].some((row) => row._id === mapping.targetId))
        throw new Error("S4 target identity missing from restored capture.");
      if (table === "projects") {
        const project = source.projects[i]!;
        const row = (await client.query(api.projects.get, {
          serviceToken,
          projectKey: project.projectKey,
        })) as Doc<"projects"> | null;
        if (!row || row._id !== mapping.targetId)
          throw new Error("Restored project identity mismatch.");
        if (
          !isDeepStrictEqual(
            row,
            actual.projects.find((value) => value._id === row._id),
          )
        )
          throw new Error("Restored project changed during readback.");
        const normal = await projects.getProjectContext(project.projectKey);
        if (
          !isDeepStrictEqual(normal, {
            projectId: row.projectKey,
            projectName: row.projectName,
            projectType: row.projectType,
            status: row.status,
            revision: row.revision,
            domains: row.domains,
            summary: row.summary,
            updatedAt: new Date(row.updatedAt).toISOString(),
          })
        )
          throw new Error("Ordinary project read mismatch.");
        restored.projects.push({ ...row, _id: project._id, _creationTime: project._creationTime });
      } else if (table === "notes") {
        const note = source.notes[i]!;
        const row = (await client.query(api.notes.get, {
          serviceToken,
          projectId: note.projectId,
          id: mapping.targetId,
        })) as Doc<"notes"> | null;
        if (!row || row._id !== mapping.targetId)
          throw new Error("Restored note identity mismatch.");
        if (
          !isDeepStrictEqual(
            row,
            actual.notes.find((value) => value._id === row._id),
          )
        )
          throw new Error("Restored note changed during readback.");
        const normal = await notes.get(note.projectId, mapping.targetId);
        if (
          !isDeepStrictEqual(normal, {
            id: row._id,
            projectId: row.projectId,
            title: row.title,
            body: row.body,
            tags: row.tags,
            domain: row.domain,
            sensitivity: row.sensitivity,
            retention: row.retention,
            sourceRequestId: row.sourceRequestId,
            correlationId: row.correlationId,
            source: row.source,
            revision: row.revision,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })
        )
          throw new Error("Ordinary note read mismatch.");
        restored.notes.push({ ...row, _id: note._id, _creationTime: note._creationTime });
      } else if (table === "projectRecords") {
        const original = source.projectRecords[i]!;
        const group = JSON.stringify([original.projectKey, original.kind]);
        let rows = recordGroups.get(group);
        if (!rows) {
          rows = (await client.query(api.projectRecords.listByKind, {
            serviceToken,
            projectKey: original.projectKey,
            kind: original.kind,
            limit: 100,
          })) as Doc<"projectRecords">[];
          const expectedRows = actual.projectRecords
            .filter((row) => row.projectKey === original.projectKey && row.kind === original.kind)
            .reverse();
          if (!isDeepStrictEqual(rows, expectedRows))
            throw new Error("Ordinary project record group read mismatch.");
          recordGroups.set(group, rows);
        }
        const row = rows.find((row) => row._id === mapping.targetId);
        if (!row) throw new Error("Restored project record missing from ordinary read.");
        restored.projectRecords.push({
          ...row,
          _id: original._id,
          _creationTime: original._creationTime,
        });
      } else if (table === "memoryChangeSets") {
        const original = source.memoryChangeSets[i]!;
        const row = (await client.query(api.memoryChangeSets.get, {
          serviceToken,
          projectKey: original.projectKey,
          changeSetId: original.changeSetId,
        })) as Doc<"memoryChangeSets"> | null;
        if (
          !row ||
          row._id !== mapping.targetId ||
          !isDeepStrictEqual(
            row,
            actual.memoryChangeSets.find((value) => value._id === row._id),
          )
        )
          throw new Error("Restored memory change set read mismatch.");
        const normal = await memory.get({
          projectId: original.projectKey,
          changeSetId: original.changeSetId,
        });
        const {
          _id: _physicalId,
          _creationTime: _physicalTime,
          ownerId: _owner,
          projectKey,
          ...values
        } = row;
        const expectedNormal = {
          ...values,
          projectId: projectKey,
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
          ...(row.approvedAt === undefined
            ? {}
            : { approvedAt: new Date(row.approvedAt).toISOString() }),
          ...(row.rejectedAt === undefined
            ? {}
            : { rejectedAt: new Date(row.rejectedAt).toISOString() }),
          ...(row.appliedAt === undefined
            ? {}
            : { appliedAt: new Date(row.appliedAt).toISOString() }),
        };
        if (!isDeepStrictEqual(normal, expectedNormal))
          throw new Error("Ordinary memory change set service read mismatch.");
        restored.memoryChangeSets.push({
          ...row,
          _id: original._id,
          _creationTime: original._creationTime,
        });
      } else {
        const original = source.auditEvents[i]!;
        const requestId = original.requestId!;
        let rows = auditRequests.get(requestId);
        if (!rows) {
          rows = (await client.query(api.auditEvents.listByRequest, {
            serviceToken,
            requestId,
            limit: 100,
          })) as Doc<"auditEvents">[];
          const expectedRows = actual.auditEvents
            .filter((row) => row.requestId === requestId)
            .reverse();
          if (!isDeepStrictEqual(rows, expectedRows))
            throw new Error("Ordinary audit request read mismatch.");
          auditRequests.set(requestId, rows);
        }
        const row = rows.find((row) => row._id === mapping.targetId);
        if (!row) throw new Error("Restored audit event missing from ordinary read.");
        restored.auditEvents.push({
          ...row,
          _id: original._id,
          _creationTime: original._creationTime,
        });
      }
    }
  }
  const sourceChecksum = groupChecksum(JSON.parse(encodeS4Payload(source).payloadJson)),
    restoredChecksum = groupChecksum(JSON.parse(encodeS4Payload(restored).payloadJson));
  if (restoredChecksum !== sourceChecksum) throw new Error("S4 restored checksum mismatch.");
  return {
    method: VERIFICATION_METHOD,
    completeness: "partial" as const,
    verifiedGroups: [] as ArchiveVerifiedGroup[],
    tables: S4_RESTORE_TABLES,
    sourceChecksum,
    restoredChecksum,
    referenceCount:
      restored.notes.length +
      restored.projectRecords.length +
      restored.memoryChangeSets.length +
      restored.auditEvents.length +
      restored.memoryChangeSets
        .filter((row) => row.state === "applied")
        .reduce((sum, row) => sum + row.records.length, 0),
  };
}
