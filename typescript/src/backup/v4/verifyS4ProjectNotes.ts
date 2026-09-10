import { isDeepStrictEqual } from "node:util";
import { encodeS4Payload } from "./convexCapture.js";
import { makeFunctionReference } from "convex/server";
import { api } from "../../../convex/_generated/api.js";
import type { Doc } from "../../../convex/_generated/dataModel.js";
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
    actual.projects.length !== source.projects.length ||
    actual.notes.length !== source.notes.length
  )
    throw new Error("S4 restored owner or count mismatch.");
  if (
    identities.projects.length !== source.projects.length ||
    identities.notes.length !== source.notes.length
  )
    throw new Error("S4 identity map count mismatch.");
  const restored = {
    ownerId: source.ownerId,
    projects: [] as Doc<"projects">[],
    notes: [] as Doc<"notes">[],
  };
  const projects = new ConvexTotalityJournal(client, serviceToken),
    notes = new ConvexNoteStore(client, serviceToken);
  for (const table of ["projects", "notes"] as const) {
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
      } else {
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
    tables: ["projects", "notes"] as const,
    sourceChecksum,
    restoredChecksum,
    referenceCount: restored.notes.length,
  };
}
