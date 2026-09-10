import {
  observeGitHubPostMerge,
  type GitHubDevelopmentClient,
  type GitHubPostMergeObservation,
} from "./githubDevelopment.js";

export interface DevelopmentOmegaGateway {
  recordPostMergeObservation(input: {
    missionId: string;
    criterionId: string;
    observation: GitHubPostMergeObservation;
    result: "pass" | "fail" | "inconclusive";
  }): Promise<void>;
  requestCompletion(input: { missionId: string; residualUncertainty: number }): Promise<void>;
}

/**
 * Thin vertical-slice coordinator. GitHub observes external truth; the
 * gateway records it through the existing Omega evidence/proof API; only
 * the existing Omega transition is then asked to complete the mission.
 */
export class GitHubDevelopmentCompletionCoordinator {
  constructor(
    private readonly github: GitHubDevelopmentClient,
    private readonly omega: DevelopmentOmegaGateway,
  ) {}

  async observeAndRequestCompletion(input: {
    missionId: string;
    repository: string;
    pullRequestNumber: number;
    baseBranch: string;
    reviewedHeadSha: string;
    criterionId: string;
    residualUncertainty: number;
    signal: AbortSignal;
  }): Promise<GitHubPostMergeObservation> {
    const observation = await observeGitHubPostMerge(this.github, input);
    // A check failure is an observation of a retryable external state, not a
    // permanent acceptance failure. Preserve the raw failed observation while
    // withholding a passing proof; a later fresh observation can establish it.
    const result = observation.status === "passed" ? "pass" : "inconclusive";
    await this.omega.recordPostMergeObservation({
      missionId: input.missionId,
      criterionId: input.criterionId,
      observation,
      result,
    });
    if (result === "pass") {
      await this.omega.requestCompletion({
        missionId: input.missionId,
        residualUncertainty: input.residualUncertainty,
      });
    }
    return observation;
  }
}
