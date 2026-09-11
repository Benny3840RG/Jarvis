import { getFunctionName, makeFunctionReference } from "convex/server";
import type { ConvexClientLike } from "../../persistence/convexPersistence.js";
import type { S4EncodedCapture, S4ProjectNotesIdentities } from "./s4ProjectNotes.js";
import type { S6Capture, S6Identities } from "./s6MutableQuotes.js";
import { verifyRestoredS4ProjectNotes } from "./verifyS4ProjectNotes.js";
import { prepareS6MutableRestore, verifyRestoredS6MutableQuotes } from "./verifyS6MutableQuotes.js";
import type { ArchiveVerifiedGroup } from "../archiveManifest.js";
/** Partial joint readback only. Existing JSON marker/archive coordinator remains unchanged. */
export async function verifyRestoredS4S6(input: {
  capture: { s4: S4EncodedCapture; s6: S6Capture };
  archive: unknown;
  destination: string;
  identities: { s4: S4ProjectNotesIdentities; s6: S6Identities };
  client: ConvexClientLike;
  serviceToken: string;
  approvalToken: string;
}) {
  const prepared = await prepareS6MutableRestore(
    input.capture.s6,
    input.archive,
    input.destination,
    input.capture.s4,
  );
  const actual = (await input.client.query(
    makeFunctionReference<"query">("backupS4:captureJoint"),
    {
      serviceToken: input.serviceToken,
      approvalToken: input.approvalToken,
      businessChecksum: prepared.businessChecksum,
    },
  )) as typeof input.capture;
  // Both existing verifiers receive views of the same provider snapshot, not separate recaptures.
  const client: ConvexClientLike = {
    query: async (ref, args) => {
      const name = getFunctionName(ref);
      if (name === "backupS4:capture") return actual.s4;
      if (name === "backupS6:capture") return actual.s6;
      return input.client.query(ref, args);
    },
    mutation: async () => {
      throw new Error("Joint verification cannot mutate.");
    },
  };
  const s4 = await verifyRestoredS4ProjectNotes(
    input.capture.s4,
    input.identities.s4,
    client,
    input.serviceToken,
    input.approvalToken,
  );
  const s6 = await verifyRestoredS6MutableQuotes({
    ...input,
    capture: input.capture.s6,
    identities: input.identities.s6,
    client,
    composedS4: { source: input.capture.s4, restored: actual.s4 },
  });
  return { s4, s6, completeness: "partial" as const, verifiedGroups: [] as ArchiveVerifiedGroup[] };
}
