import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubDevelopmentCompletionCoordinator,
  type DevelopmentOmegaGateway,
} from "../src/development/developmentCompletion.js";
import type { GitHubDevelopmentClient } from "../src/development/githubDevelopment.js";

const headSha = "a".repeat(40);
const mergeSha = "b".repeat(40);

function github(checkConclusion = "success"): GitHubDevelopmentClient {
  return {
    async getIssue() {
      throw new Error("not used");
    },
    async getPullRequest() {
      return {
        number: 42,
        state: "closed",
        merged: true,
        draft: false,
        baseBranch: "main",
        headSha,
        mergeCommitSha: mergeSha,
      };
    },
    async mergePullRequest() {
      throw new Error("not used");
    },
    async getCommit() {
      return { sha: mergeSha };
    },
    async getCommitChecks() {
      return [{ name: "test", status: "completed", conclusion: checkConclusion }];
    },
  };
}

class Gateway implements DevelopmentOmegaGateway {
  readonly calls: string[] = [];

  async recordPostMergeObservation(input: { result: "pass" | "fail" | "inconclusive" }) {
    this.calls.push(`proof:${input.result}`);
  }

  async requestCompletion() {
    this.calls.push("omega:complete");
  }
}

test("post-merge coordinator records evidence then delegates completion to existing Omega", async () => {
  const gateway = new Gateway();
  const coordinator = new GitHubDevelopmentCompletionCoordinator(github(), gateway);

  const result = await coordinator.observeAndRequestCompletion({
    missionId: "mission-1",
    repository: "Benny3840RG/Jarvis",
    pullRequestNumber: 42,
    baseBranch: "main",
    reviewedHeadSha: headSha,
    criterionId: "post-merge-ci",
    residualUncertainty: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(gateway.calls, ["proof:pass", "omega:complete"]);
});

test("failed post-merge CI is durable evidence but can never request completion", async () => {
  const gateway = new Gateway();
  const coordinator = new GitHubDevelopmentCompletionCoordinator(github("failure"), gateway);

  const result = await coordinator.observeAndRequestCompletion({
    missionId: "mission-1",
    repository: "Benny3840RG/Jarvis",
    pullRequestNumber: 42,
    baseBranch: "main",
    reviewedHeadSha: headSha,
    criterionId: "post-merge-ci",
    residualUncertainty: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(gateway.calls, ["proof:fail"]);
});
