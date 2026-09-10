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
      return [
        "automation-policy",
        "typecheck-lint-format-test",
        "jarvis-console-01-build",
        ...["actions", "python", "ruby", "javascript-typescript"].map(
          (language) => `Analyze (${language})`,
        ),
      ].map((name, index) => ({
        id: index + 1,
        name,
        status: "completed" as const,
        conclusion: checkConclusion,
        appSlug: "github-actions",
        workflowEvent: name.startsWith("Analyze") ? "dynamic" : "push",
        workflowBranch: "main",
        workflowPath: name.startsWith("Analyze")
          ? "dynamic/github-code-scanning/codeql"
          : ".github/workflows/typescript.yml",
      }));
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
  assert.deepEqual(gateway.calls, ["proof:inconclusive"]);
});

for (const defect of [
  "neutral",
  "skipped",
  "missing",
  "missing-codeql",
  "stale-success",
  "wrong-app",
  "wrong-path",
  "wrong-event",
  "wrong-branch",
  "pending",
  "legacy",
  "commit-mismatch",
]) {
  test(`untrusted or incomplete ${defect} evidence cannot complete Omega`, async () => {
    const provider = github();
    const checks = await provider.getCommitChecks({
      repository: "Benny3840RG/Jarvis",
      sha: mergeSha,
      signal: new AbortController().signal,
    });
    provider.getCommitChecks = async () =>
      defect === "missing"
        ? checks.slice(1)
        : defect === "missing-codeql"
          ? checks.slice(0, -1)
          : defect === "stale-success"
            ? [...checks, { ...checks[0]!, id: 100, conclusion: "failure" }]
            : checks.map((check) => ({
                ...check,
                ...(["neutral", "skipped"].includes(defect) ? { conclusion: defect } : {}),
                ...(defect === "wrong-app" ? { appSlug: "untrusted" } : {}),
                ...(defect === "wrong-path"
                  ? { workflowPath: ".github/workflows/attacker.yml" }
                  : {}),
                ...(defect === "wrong-event" ? { workflowEvent: "pull_request" } : {}),
                ...(defect === "wrong-branch" ? { workflowBranch: "refs/pull/12/head" } : {}),
                ...(defect === "pending" ? { status: "queued" as const } : {}),
                ...(defect === "legacy" ? { appSlug: undefined, workflowPath: undefined } : {}),
              }));
    if (defect === "commit-mismatch") provider.getCommit = async () => ({ sha: "c".repeat(40) });
    const gateway = new Gateway();
    const result = await new GitHubDevelopmentCompletionCoordinator(
      provider,
      gateway,
    ).observeAndRequestCompletion({
      missionId: "mission-1",
      repository: "Benny3840RG/Jarvis",
      pullRequestNumber: 42,
      baseBranch: "main",
      reviewedHeadSha: headSha,
      criterionId: "post-merge-ci",
      residualUncertainty: 0,
      signal: new AbortController().signal,
    });
    assert.notEqual(result.status, "passed");
    assert.equal(gateway.calls.includes("omega:complete"), false);
  });
}

test("parallel code-quality Analyze checks cannot replace required scanning producers", async () => {
  const provider = github();
  const original = await provider.getCommitChecks({
    repository: "Benny3840RG/Jarvis",
    sha: mergeSha,
    signal: new AbortController().signal,
  });
  provider.getCommitChecks = async () => [
    ...original,
    ...original
      .filter((check) => check.name.startsWith("Analyze"))
      .map((check) => ({
        ...check,
        id: check.id! + 100,
        workflowPath: "dynamic/github-code-quality/codeql",
      })),
  ];
  const gateway = new Gateway();
  const result = await new GitHubDevelopmentCompletionCoordinator(
    provider,
    gateway,
  ).observeAndRequestCompletion({
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
});

for (const metadata of [{ workflowEvent: "push" }, { workflowBranch: "refs/pull/12/head" }]) {
  test("CodeQL requires a dynamic analysis on the actual merge base branch", async () => {
    const provider = github();
    const original = await provider.getCommitChecks({
      repository: "Benny3840RG/Jarvis",
      sha: mergeSha,
      signal: new AbortController().signal,
    });
    provider.getCommitChecks = async () =>
      original.map((check) =>
        check.name.startsWith("Analyze") ? { ...check, ...metadata } : check,
      );
    const gateway = new Gateway();
    const result = await new GitHubDevelopmentCompletionCoordinator(
      provider,
      gateway,
    ).observeAndRequestCompletion({
      missionId: "mission-1",
      repository: "Benny3840RG/Jarvis",
      pullRequestNumber: 42,
      baseBranch: "main",
      reviewedHeadSha: headSha,
      criterionId: "post-merge-ci",
      residualUncertainty: 0,
      signal: new AbortController().signal,
    });
    assert.notEqual(result.status, "passed");
    assert.equal(gateway.calls.includes("omega:complete"), false);
  });
}

for (const metadata of [
  { appSlug: "untrusted" },
  { workflowPath: ".github/workflows/foreign.yml" },
]) {
  test("newer untrusted same-name success cannot fall back to older green evidence", async () => {
    const provider = github();
    const checks = await provider.getCommitChecks({
      repository: "o/r",
      sha: mergeSha,
      signal: new AbortController().signal,
    });
    provider.getCommitChecks = async () => [
      ...checks,
      ...checks.map((check) => ({ ...check, id: check.id! + 100, ...metadata })),
    ];
    const gateway = new Gateway();
    const result = await new GitHubDevelopmentCompletionCoordinator(
      provider,
      gateway,
    ).observeAndRequestCompletion({
      missionId: "mission-1",
      repository: "o/r",
      pullRequestNumber: 42,
      baseBranch: "main",
      reviewedHeadSha: headSha,
      criterionId: "post-merge-ci",
      residualUncertainty: 0,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "failed");
    assert.equal(gateway.calls.includes("omega:complete"), false);
  });
}
test("failed then green observations do not leave an immutable failed completion proof", async () => {
  const provider = github("failure");
  const gateway = new Gateway();
  const coordinator = new GitHubDevelopmentCompletionCoordinator(provider, gateway);
  const input = {
    missionId: "mission-1",
    repository: "o/r",
    pullRequestNumber: 42,
    baseBranch: "main",
    reviewedHeadSha: headSha,
    criterionId: "post-merge-ci",
    residualUncertainty: 0,
    signal: new AbortController().signal,
  };
  await coordinator.observeAndRequestCompletion(input);
  provider.getCommitChecks = github().getCommitChecks;
  await coordinator.observeAndRequestCompletion(input);
  assert.deepEqual(gateway.calls, ["proof:inconclusive", "proof:pass", "omega:complete"]);
});
