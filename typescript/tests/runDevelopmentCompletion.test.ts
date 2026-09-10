import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import {
  resolveDevelopmentCompletionConfig,
  completeExistingDevelopmentMission,
} from "../src/tools/runDevelopmentCompletion.js";
import type { GitHubDevelopmentClient } from "../src/development/githubDevelopment.js";
const head = "a".repeat(40);
const merge = "b".repeat(40);
function fixture() {
  const rows: Record<string, unknown> = {
    "developmentState:get": {
      subjectId: "mission-1",
      omegaMissionId: "mission-1",
      state: "MERGED",
      repository: "owner/repo",
      branch: "main",
      lastEventId: "merge-event",
    },
    "omegaMissions:get": {
      missionId: "mission-1",
      state: "active",
      acceptanceCriteria: [
        {
          criterionId: "post-merge-ci",
          statement: "The merged commit exists and required post-merge CI passes.",
        },
      ],
    },
    "developmentState:listEvents": [
      {
        subjectId: "mission-1",
        eventId: "merge-event",
        eventType: "DEV_TRANSITION_COMMITTED",
        transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
        payload: { to: "MERGED", mergeReceiptKey: "receipt-1" },
      },
    ],
    "toolExecutionReceipts:get": {
      receiptKey: "receipt-1",
      projectId: "mission-1",
      actionId: "action-1",
      status: "succeeded",
      provider: "github-rest-v1",
    },
    "toolActions:get": {
      actionId: "action-1",
      projectKey: "mission-1",
      tool: "github",
      operation: "merge-pull-request",
      approvedBy: "user",
      requiredAuthority: "T3",
      destructive: true,
      consumptionPolicy: "single-use",
      arguments: {
        subjectId: "mission-1",
        repository: "owner/repo",
        baseBranch: "main",
        pullRequestNumber: 12,
        reviewedHeadSha: head,
        transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
      },
    },
  };
  const mutations: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    async query(reference: unknown) {
      return rows[getFunctionName(reference as Parameters<typeof getFunctionName>[0])] ?? null;
    },
    async mutation(reference: unknown, args: Record<string, unknown>) {
      mutations.push({
        name: getFunctionName(reference as Parameters<typeof getFunctionName>[0]),
        args,
      });
      return {};
    },
  };
  const github: GitHubDevelopmentClient = {
    async getIssue() {
      throw new Error("unused");
    },
    async mergePullRequest() {
      throw new Error("must never merge");
    },
    async getPullRequest(input) {
      assert.equal(input.pullRequestNumber, 12);
      return {
        number: 12,
        state: "closed",
        merged: true,
        draft: false,
        baseBranch: "main",
        headSha: head,
        mergeCommitSha: merge,
      };
    },
    async getCommit() {
      return { sha: merge };
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
        status: "completed",
        conclusion: "success",
        appSlug: "github-actions",
        workflowEvent: name.startsWith("Analyze") ? "dynamic" : "push",
        workflowBranch: "main",
        workflowPath: name.startsWith("Analyze")
          ? "dynamic/github-code-scanning/codeql"
          : ".github/workflows/typescript.yml",
      }));
    },
  };
  return { rows, client, github, mutations };
}
const request = {
  missionId: "mission-1",
  residualUncertainty: 0.15,
  serviceToken: "service",
  approvalToken: "approval",
  signal: new AbortController().signal,
};
test("existing durable merge binding drives observation, proof and real Omega completion", async () => {
  const f = fixture();
  const result = await completeExistingDevelopmentMission({
    ...request,
    client: f.client,
    github: f.github,
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(
    f.mutations.map((x) => x.name),
    [
      "omegaMissions:recordEvidence",
      "omegaMissions:recordValidationProof",
      "omegaMissions:transition",
      "omegaMissions:transition",
    ],
  );
  assert.equal(f.mutations.at(-1)?.args.residualUncertainty, 0.15);
  assert.equal(f.mutations[1]?.args.criterionId, "post-merge-ci");
});
for (const defect of [
  "subject",
  "event",
  "unmerged",
  "criterion",
  "statement",
  "receipt",
  "action",
  "repository",
  "head",
  "uncertainty",
]) {
  test(`refuses ${defect} mismatch before any durable write`, async () => {
    const f = fixture();
    if (defect === "subject") f.rows["developmentState:get"] = null;
    if (defect === "event") f.rows["developmentState:listEvents"] = [];
    if (defect === "unmerged")
      (f.rows["developmentState:get"] as { state: string }).state = "READY_TO_MERGE";
    if (defect === "criterion" || defect === "statement")
      f.rows["omegaMissions:get"] = {
        missionId: "mission-1",
        state: "active",
        acceptanceCriteria: [
          {
            criterionId: defect === "criterion" ? "other" : "post-merge-ci",
            statement: "Wrong criterion",
          },
        ],
      };
    if (defect === "receipt") f.rows["toolExecutionReceipts:get"] = null;
    if (["action", "repository", "head"].includes(defect)) {
      const a = f.rows["toolActions:get"] as {
        approvedBy: string;
        arguments: Record<string, unknown>;
      };
      if (defect === "action") a.approvedBy = "model";
      else
        a.arguments[defect === "head" ? "reviewedHeadSha" : "repository"] =
          defect === "head" ? "short" : "other/repo";
    }
    await assert.rejects(
      completeExistingDevelopmentMission({
        ...request,
        residualUncertainty: defect === "uncertainty" ? NaN : 0.15,
        client: f.client,
        github: f.github,
      }),
    );
    assert.equal(f.mutations.length, 0);
  });
}
test("failed GitHub checks record a failure proof without requesting completion", async () => {
  const f = fixture();
  f.github.getCommitChecks = async () => [
    { name: "test", status: "completed", conclusion: "failure" },
  ];
  const result = await completeExistingDevelopmentMission({
    ...request,
    client: f.client,
    github: f.github,
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(
    f.mutations.map((x) => x.name),
    ["omegaMissions:recordEvidence", "omegaMissions:recordValidationProof"],
  );
});
test("configuration refuses production or mismatched dev endpoint and absent explicit uncertainty", () => {
  const env = {
    CONVEX_DEPLOYMENT: "dev:quiet-otter-123",
    CONVEX_URL: "https://quiet-otter-123.convex.cloud",
    JARVIS_SERVICE_TOKEN: "service",
    JARVIS_APPROVAL_TOKEN: "approval",
    JARVIS_GITHUB_TOKEN: "github",
  };
  assert.equal(
    resolveDevelopmentCompletionConfig(["mission-1", "0.15"], env).residualUncertainty,
    0.15,
  );
  for (const args of [["mission-1"], ["mission-1", ""], ["mission-1", "NaN"], ["mission-1", "2"]])
    assert.throws(() => resolveDevelopmentCompletionConfig(args, env));
  assert.throws(() =>
    resolveDevelopmentCompletionConfig(["mission-1", "0"], {
      ...env,
      CONVEX_DEPLOYMENT: "prod:quiet-otter-123",
    }),
  );
  assert.throws(() =>
    resolveDevelopmentCompletionConfig(["mission-1", "0"], {
      ...env,
      CONVEX_URL: "https://production.convex.cloud",
    }),
  );
});
