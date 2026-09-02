import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import type { DevelopmentOmegaGateway } from "./developmentCompletion.js";

type ConvexClientLike = {
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  query(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
};

const recordEvidence = makeFunctionReference<"mutation">("omegaMissions:recordEvidence");
const recordValidationProof = makeFunctionReference<"mutation">(
  "omegaMissions:recordValidationProof",
);
const getMission = makeFunctionReference<"query">("omegaMissions:get");
const transitionMission = makeFunctionReference<"mutation">("omegaMissions:transition");

export class ConvexDevelopmentOmegaGateway implements DevelopmentOmegaGateway {
  constructor(
    private readonly client: ConvexClientLike,
    private readonly serviceToken: string,
    private readonly approvalToken: string,
  ) {
    if (!serviceToken.trim()) throw new Error("Jarvis service token is required.");
    if (!approvalToken.trim())
      throw new Error("Omega independent-proof approval token is required.");
  }

  async recordPostMergeObservation(
    input: Parameters<DevelopmentOmegaGateway["recordPostMergeObservation"]>[0],
  ): Promise<void> {
    const classification = input.result === "inconclusive" ? "unknown" : "certain";
    const claim =
      input.result === "pass"
        ? "GitHub reports the merged commit exists and all observed post-merge checks passed."
        : input.result === "fail"
          ? `GitHub reports post-merge validation failed: ${input.observation.reason ?? "provider-state-failure"}.`
          : `GitHub post-merge validation remains unresolved: ${input.observation.reason ?? "unknown"}.`;
    await this.client.mutation(recordEvidence, {
      serviceToken: this.serviceToken,
      missionId: input.missionId,
      evidenceId: input.observation.evidenceId,
      claim,
      classification,
      sourceType: "primary-source",
      sourceRef: input.observation.sourceRef,
      contradicts: [],
    });
    await this.client.mutation(recordValidationProof, {
      serviceToken: this.serviceToken,
      approvalToken: this.approvalToken,
      missionId: input.missionId,
      proofId: `post-merge-proof:${input.observation.evidenceDigest}`,
      criterionId: input.criterionId,
      method: "independent",
      result: input.result,
      independent: true,
      evidenceRefs: [input.observation.evidenceId],
      performedBy: "github-post-merge-observer",
    });
  }

  async requestCompletion(
    input: Parameters<DevelopmentOmegaGateway["requestCompletion"]>[0],
  ): Promise<void> {
    const mission = (await this.client.query(getMission, {
      serviceToken: this.serviceToken,
      missionId: input.missionId,
    })) as { state: string } | null;
    if (!mission) throw new Error("Omega mission does not exist.");
    // A retried/duplicate call landing after a prior call already completed
    // the mission is a legitimate idempotent no-op, not an error -- mirrors
    // recordPostMergeObservation's own idempotent evidence/proof writes.
    if (mission.state === "complete") return;
    if (mission.state === "active" || mission.state === "partial") {
      await this.client.mutation(transitionMission, {
        serviceToken: this.serviceToken,
        missionId: input.missionId,
        nextState: "validating",
      });
    } else if (mission.state !== "validating") {
      throw new Error(`Omega mission cannot enter completion from state: ${mission.state}.`);
    }
    await this.client.mutation(transitionMission, {
      serviceToken: this.serviceToken,
      missionId: input.missionId,
      nextState: "complete",
      residualUncertainty: input.residualUncertainty,
    });
  }
}

export function createConvexDevelopmentOmegaGateway(
  convexUrl: string,
  serviceToken: string,
  approvalToken: string,
): ConvexDevelopmentOmegaGateway {
  return new ConvexDevelopmentOmegaGateway(
    new ConvexHttpClient(convexUrl) as unknown as ConvexClientLike,
    serviceToken,
    approvalToken,
  );
}
