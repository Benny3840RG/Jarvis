import assert from "node:assert/strict";
import test from "node:test";

import { ConvexDevelopmentOmegaGateway } from "../src/development/convexDevelopmentOmegaGateway.js";

test("Convex Omega gateway reuses evidence, proof, and completion mutations in order", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    async mutation(reference: unknown, args: Record<string, unknown>) {
      calls.push({ name: String(reference), args });
      return {};
    },
    async query(_reference: unknown, args: Record<string, unknown>) {
      calls.push({ name: "query", args });
      return { state: "active" };
    },
  };
  const gateway = new ConvexDevelopmentOmegaGateway(client, "service-token", "approval-token");

  await gateway.recordPostMergeObservation({
    missionId: "mission-1",
    criterionId: "post-merge-ci",
    result: "pass",
    observation: {
      status: "passed",
      missionId: "mission-1",
      repository: "Benny3840RG/Jarvis",
      pullRequestNumber: 42,
      reviewedHeadSha: "a".repeat(40),
      mergeCommitSha: "b".repeat(40),
      evidenceId: "github-post-merge-ci:digest",
      evidenceDigest: "digest",
      sourceRef: "github-rest-v1:Benny3840RG/Jarvis:commit:sha",
    },
  });
  await gateway.requestCompletion({ missionId: "mission-1", residualUncertainty: 0 });

  assert.equal(calls[0]?.args.evidenceId, "github-post-merge-ci:digest");
  assert.deepEqual(
    {
      proofId: calls[1]?.args.proofId,
      result: calls[1]?.args.result,
      independent: calls[1]?.args.independent,
      approvalToken: calls[1]?.args.approvalToken,
    },
    {
      proofId: "post-merge-proof:digest",
      result: "pass",
      independent: true,
      approvalToken: "approval-token",
    },
  );
  assert.deepEqual(
    calls.slice(2).map((call) => call.args),
    [
      { serviceToken: "service-token", missionId: "mission-1" },
      { serviceToken: "service-token", missionId: "mission-1", nextState: "validating" },
      {
        serviceToken: "service-token",
        missionId: "mission-1",
        nextState: "complete",
        residualUncertainty: 0,
      },
    ],
  );
});
