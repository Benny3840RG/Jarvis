import { isDeepStrictEqual } from "node:util";

import { makeFunctionReference } from "convex/server";

import { api } from "../../../convex/_generated/api.js";
import type { Doc } from "../../../convex/_generated/dataModel.js";
import type { ConvexClientLike } from "../../persistence/convexPersistence.js";
import { encodeS4Payload } from "./convexCapture.js";
import {
  readS5TerminalOrchestration,
  S5_TABLES,
  type S5EncodedCapture,
  type S5TerminalIdentities,
  type S5TerminalSource,
} from "./s5TerminalOrchestration.js";

function withoutSystem<T extends { _id: string; _creationTime: number }>(row: T) {
  const { _id: _ignoredId, _creationTime: _ignoredTime, ...fields } = row;
  return fields;
}

/** Partial proof only. This cannot seal the orchestration archive group. */
export async function verifyRestoredS5TerminalOrchestration(
  capture: S5EncodedCapture,
  identities: S5TerminalIdentities,
  client: ConvexClientLike,
  serviceToken: string,
  approvalToken: string,
) {
  const source = readS5TerminalOrchestration(capture);
  const actualCapture = (await client.query(makeFunctionReference<"query">("backupS5:capture"), {
    serviceToken,
    approvalToken,
  })) as S5EncodedCapture;
  const actual = readS5TerminalOrchestration(actualCapture);
  if (
    actual.ownerId !== source.ownerId ||
    S5_TABLES.some((table) => actual[table].length !== source[table].length) ||
    S5_TABLES.some((table) => identities[table].length !== source[table].length)
  )
    throw new Error("S5 restored owner or count mismatch.");

  const restored: S5TerminalSource = {
    ownerId: source.ownerId,
    orchestrationRuns: [],
    orchestrationSteps: [],
    orchestrationReconciliations: [],
  };
  for (const table of S5_TABLES) {
    let previousTargetTime = Number.NEGATIVE_INFINITY;
    const targets = new Set<string>();
    for (let index = 0; index < source[table].length; index++) {
      const expected = source[table][index]!;
      const mapping = identities[table][index]!;
      if (
        mapping.sourceId !== expected._id ||
        mapping.sourceCreationTime !== expected._creationTime ||
        targets.has(mapping.targetId)
      )
        throw new Error("Invalid or duplicate S5 identity map.");
      targets.add(mapping.targetId);
      const targetRow = actual[table].find((row) => row._id === mapping.targetId);
      if (!targetRow) throw new Error("S5 target identity missing from restored capture.");
      if (targetRow._creationTime < previousTargetTime)
        throw new Error("S5 restored source ordering mismatch.");
      previousTargetTime = targetRow._creationTime;
      if (!isDeepStrictEqual(withoutSystem(targetRow), withoutSystem(expected)))
        throw new Error("S5 restored document changed.");
      if (table === "orchestrationRuns") {
        const run = expected as Doc<"orchestrationRuns">;
        const ordinary = (await client.query(api.orchestrationState.getRun, {
          serviceToken,
          runId: run.runId,
        })) as Doc<"orchestrationRuns"> | null;
        if (!ordinary || ordinary._id !== mapping.targetId)
          throw new Error("Ordinary orchestration run read mismatch.");
        if (!isDeepStrictEqual(withoutSystem(ordinary), withoutSystem(targetRow)))
          throw new Error("Ordinary orchestration run changed during readback.");
        restored.orchestrationRuns.push({
          ...ordinary,
          _id: run._id,
          _creationTime: run._creationTime,
        });
      } else if (table === "orchestrationSteps") {
        const step = expected as Doc<"orchestrationSteps">;
        restored.orchestrationSteps.push({
          ...(targetRow as Doc<"orchestrationSteps">),
          _id: step._id,
          _creationTime: step._creationTime,
        });
      } else {
        const reconciliation = expected as Doc<"orchestrationReconciliations">;
        restored.orchestrationReconciliations.push({
          ...(targetRow as Doc<"orchestrationReconciliations">),
          _id: reconciliation._id,
          _creationTime: reconciliation._creationTime,
        });
      }
    }
  }
  for (const run of source.orchestrationRuns) {
    const steps = (await client.query(api.orchestrationState.listSteps, {
      serviceToken,
      runId: run.runId,
    })) as Array<Doc<"orchestrationSteps"> & { leaseToken?: string }>;
    const expected = source.orchestrationSteps.filter((step) => step.runId === run.runId);
    if (steps.length !== expected.length)
      throw new Error("Ordinary orchestration step count mismatch.");
    for (const step of steps) {
      if ("leaseToken" in step && step.leaseToken !== undefined)
        throw new Error("Ordinary orchestration step exposed a lease token.");
      const match = expected.find((row) => row.nodeId === step.nodeId);
      if (!match || step.state !== match.state || step.retryable !== false)
        throw new Error("Ordinary orchestration step read mismatch.");
      if (step.leaseOwner !== undefined || step.leaseExpiresAt !== undefined)
        throw new Error("Ordinary orchestration step retained a live lease.");
    }
  }
  const sourceChecksum = encodeS4Payload({
    runs: source.orchestrationRuns.map(withoutSystem),
    steps: source.orchestrationSteps.map(withoutSystem),
    reconciliations: source.orchestrationReconciliations.map(withoutSystem),
  }).payloadSha256;
  const restoredChecksum = encodeS4Payload({
    runs: restored.orchestrationRuns.map(withoutSystem),
    steps: restored.orchestrationSteps.map(withoutSystem),
    reconciliations: restored.orchestrationReconciliations.map(withoutSystem),
  }).payloadSha256;
  if (sourceChecksum !== restoredChecksum) throw new Error("S5 restored digest mismatch.");
  return {
    completeness: "partial" as const,
    verifiedGroups: [] as const,
    sourceChecksum,
    restoredChecksum,
  };
}
