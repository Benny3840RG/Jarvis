import { z } from "zod";
import {
  ToolExecutionPreconditionError,
  type ToolExecutionDefinition,
} from "../actions/toolExecution.js";
import { canonicalJson } from "../actions/canonicalJson.js";
import { sha256Hex } from "../actions/sha256.js";
import type {
  ProviderReconciliationAdapter,
  ProviderReconciliationResult,
} from "../reconciliation/externalReconciliation.js";

const GITHUB_PROVIDER = "github-rest-v1";
const GITHUB_API_VERSION = "2026-03-10";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export type GitHubIssueObservation = {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string | null;
  labels: string[];
  isPullRequest: boolean;
};

export type GitHubPullRequestObservation = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  baseBranch: string;
  headSha: string;
  mergeCommitSha?: string;
};

export type GitHubMergeObservation = {
  merged: boolean;
  mergeCommitSha?: string;
  message: string;
};

export type GitHubCommitObservation = { sha: string };
export type GitHubCommitCheckObservation = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
};

export interface GitHubDevelopmentClient {
  getIssue(input: {
    repository: string;
    issueNumber: number;
    signal: AbortSignal;
  }): Promise<GitHubIssueObservation>;
  getPullRequest(input: {
    repository: string;
    pullRequestNumber: number;
    signal: AbortSignal;
  }): Promise<GitHubPullRequestObservation>;
  mergePullRequest(input: {
    repository: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
    mergeMethod: "merge" | "squash" | "rebase";
    signal: AbortSignal;
  }): Promise<GitHubMergeObservation>;
  getCommit(input: {
    repository: string;
    sha: string;
    signal: AbortSignal;
  }): Promise<GitHubCommitObservation>;
  getCommitChecks(input: {
    repository: string;
    sha: string;
    signal: AbortSignal;
  }): Promise<GitHubCommitCheckObservation[]>;
}

export type ValidatedGitHubDevelopmentMission = {
  repository: string;
  issueNumber: number;
  title: string;
  objective: string;
  acceptanceCriteria: string;
  issueEvidenceDigest: string;
};

function repositoryParts(repository: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match) throw new Error("GitHub repository must use owner/name format.");
  return { owner: match[1]!, repo: match[2]! };
}

function requiredSha(value: string, label: string): string {
  const cleaned = value.trim().toLowerCase();
  if (!SHA_PATTERN.test(cleaned)) throw new Error(`${label} must be a full 40-character SHA.`);
  return cleaned;
}

export class GitHubRestError extends Error {
  constructor(
    readonly status: number,
    readonly requestId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GitHubRestError";
  }
}

export class FetchGitHubDevelopmentClient implements GitHubDevelopmentClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.github.com",
  ) {
    if (!token.trim()) throw new Error("A GitHub token is required.");
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "jarvis-governed-development-phase1",
        ...init.headers,
      },
    });
    if (!response.ok) {
      let message = `GitHub REST request failed with status ${response.status}.`;
      try {
        const body = (await response.json()) as { message?: unknown };
        if (typeof body.message === "string" && body.message.trim()) message = body.message;
      } catch {
        // Status and request ID remain sufficient structured failure evidence.
      }
      throw new GitHubRestError(
        response.status,
        response.headers.get("x-github-request-id") ?? undefined,
        message,
      );
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async getIssue(input: {
    repository: string;
    issueNumber: number;
    signal: AbortSignal;
  }): Promise<GitHubIssueObservation> {
    const { owner, repo } = repositoryParts(input.repository);
    const body = (await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${input.issueNumber}`,
      { method: "GET", signal: input.signal },
    )) as {
      number: number;
      state: "open" | "closed";
      title: string;
      body: string | null;
      labels: Array<string | { name?: string }>;
      pull_request?: unknown;
    };
    return {
      number: body.number,
      state: body.state,
      title: body.title,
      body: body.body,
      labels: body.labels.flatMap((label) =>
        typeof label === "string" ? [label] : typeof label.name === "string" ? [label.name] : [],
      ),
      isPullRequest: body.pull_request !== undefined,
    };
  }

  async getPullRequest(input: {
    repository: string;
    pullRequestNumber: number;
    signal: AbortSignal;
  }): Promise<GitHubPullRequestObservation> {
    const { owner, repo } = repositoryParts(input.repository);
    const body = (await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.pullRequestNumber}`,
      { method: "GET", signal: input.signal },
    )) as {
      number: number;
      state: "open" | "closed";
      merged: boolean;
      draft?: boolean;
      base: { ref: string };
      head: { sha: string };
      merge_commit_sha?: string | null;
    };
    return {
      number: body.number,
      state: body.state,
      merged: body.merged,
      draft: body.draft === true,
      baseBranch: body.base.ref,
      headSha: requiredSha(body.head.sha, "GitHub pull request head"),
      ...(body.merge_commit_sha && SHA_PATTERN.test(body.merge_commit_sha)
        ? { mergeCommitSha: body.merge_commit_sha.toLowerCase() }
        : {}),
    };
  }

  async mergePullRequest(input: {
    repository: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
    mergeMethod: "merge" | "squash" | "rebase";
    signal: AbortSignal;
  }): Promise<GitHubMergeObservation> {
    const { owner, repo } = repositoryParts(input.repository);
    const body = (await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.pullRequestNumber}/merge`,
      {
        method: "PUT",
        signal: input.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sha: requiredSha(input.expectedHeadSha, "Expected pull request head"),
          merge_method: input.mergeMethod,
        }),
      },
    )) as { sha?: string | null; merged: boolean; message: string };
    return {
      merged: body.merged,
      message: body.message,
      ...(body.sha && SHA_PATTERN.test(body.sha) ? { mergeCommitSha: body.sha.toLowerCase() } : {}),
    };
  }

  async getCommit(input: {
    repository: string;
    sha: string;
    signal: AbortSignal;
  }): Promise<GitHubCommitObservation> {
    const { owner, repo } = repositoryParts(input.repository);
    const body = (await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${requiredSha(input.sha, "Commit SHA")}`,
      { method: "GET", signal: input.signal },
    )) as { sha: string };
    return { sha: requiredSha(body.sha, "Observed commit SHA") };
  }

  async getCommitChecks(input: {
    repository: string;
    sha: string;
    signal: AbortSignal;
  }): Promise<GitHubCommitCheckObservation[]> {
    const { owner, repo } = repositoryParts(input.repository);
    const body = (await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${requiredSha(input.sha, "Commit SHA")}/check-runs?per_page=100`,
      { method: "GET", signal: input.signal },
    )) as {
      check_runs: Array<{
        name: string;
        status: "queued" | "in_progress" | "completed";
        conclusion: string | null;
      }>;
    };
    return body.check_runs.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
    }));
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

export function createGitHubDevelopmentClientFromEnv(
  environment: Environment = process.env,
): GitHubDevelopmentClient | null {
  const token = environment.JARVIS_GITHUB_TOKEN?.trim();
  return token ? new FetchGitHubDevelopmentClient(token) : null;
}

const githubMergeArguments = z.object({
  subjectId: z.string().trim().min(1).max(200),
  transitionId: z.literal("DEV_TRANSITION_READY_TO_MERGE_TO_MERGED"),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pullRequestNumber: z.number().int().positive(),
  baseBranch: z.string().trim().min(1).max(200),
  reviewedHeadSha: z.string().regex(SHA_PATTERN),
  mergeMethod: z.enum(["merge", "squash", "rebase"]),
  authorityEnvelopeHash: z.string().trim().min(1),
  policyDecisionFingerprint: z.string().trim().min(1),
  effectiveRisk: z.number().int().min(4),
});

type GitHubMergeArguments = z.infer<typeof githubMergeArguments>;

function assertMergePreconditions(
  args: GitHubMergeArguments,
  observation: GitHubPullRequestObservation,
): void {
  if (observation.merged) {
    throw new ToolExecutionPreconditionError("Pull request is already merged; reconcile it.");
  }
  if (observation.state !== "open") {
    throw new ToolExecutionPreconditionError("Pull request is not open.");
  }
  if (observation.draft)
    throw new ToolExecutionPreconditionError("Draft pull request cannot merge.");
  if (observation.baseBranch !== args.baseBranch) {
    throw new ToolExecutionPreconditionError(
      "Pull request base branch no longer matches approval.",
    );
  }
  if (observation.headSha.toLowerCase() !== args.reviewedHeadSha.toLowerCase()) {
    throw new ToolExecutionPreconditionError("Pull request head no longer matches reviewed SHA.");
  }
}

function providerOperationReference(args: GitHubMergeArguments): string {
  return `${GITHUB_PROVIDER}:${args.repository}:pull:${args.pullRequestNumber}:base:${encodeURIComponent(args.baseBranch)}:sha:${args.reviewedHeadSha.toLowerCase()}`;
}

function observationDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function issueSection(body: string, heading: string, nextHeading?: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = nextHeading
    ? `(?=^#{1,6}\\s+${nextHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$)`
    : "(?=^#{1,6}\\s+|$)";
  const match = new RegExp(`^#{1,6}\\s+${escaped}\\s*$\\n([\\s\\S]*?)${end}`, "imu").exec(body);
  return match?.[1]?.trim() ?? "";
}

export async function validateGitHubDevelopmentIssue(
  client: GitHubDevelopmentClient,
  input: {
    repository: string;
    issueNumber: number;
    requiredLabel?: string;
    signal: AbortSignal;
  },
): Promise<ValidatedGitHubDevelopmentMission> {
  repositoryParts(input.repository);
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new Error("GitHub issue number must be a positive safe integer.");
  }
  const issue = await client.getIssue(input);
  if (issue.isPullRequest)
    throw new Error("Development mission source must be an issue, not a PR.");
  if (issue.state !== "open") throw new Error("Development mission issue must be open.");
  const requiredLabel = input.requiredLabel ?? "jarvis-development";
  if (!issue.labels.includes(requiredLabel)) {
    throw new Error(`Development mission issue is missing required label: ${requiredLabel}.`);
  }
  const body = issue.body ?? "";
  const objective = issueSection(body, "Objective", "Acceptance Criteria");
  const acceptanceCriteria = issueSection(body, "Acceptance Criteria");
  if (!issue.title.trim()) throw new Error("Development mission title cannot be empty.");
  if (!objective) throw new Error("Development mission issue requires an Objective section.");
  if (!acceptanceCriteria) {
    throw new Error("Development mission issue requires an Acceptance Criteria section.");
  }
  return {
    repository: input.repository,
    issueNumber: issue.number,
    title: issue.title.trim(),
    objective,
    acceptanceCriteria,
    issueEvidenceDigest: observationDigest({ repository: input.repository, issue }),
  };
}

function parseProviderOperationReference(reference: string): GitHubMergeArguments {
  const match = /^github-rest-v1:([^/]+\/[^:]+):pull:(\d+):base:([^:]+):sha:([0-9a-f]{40})$/i.exec(
    reference,
  );
  if (!match) throw new Error("GitHub reconciliation reference is invalid.");
  return githubMergeArguments.parse({
    subjectId: "__reconciliation_reference__",
    transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
    repository: match[1],
    pullRequestNumber: Number(match[2]),
    baseBranch: decodeURIComponent(match[3]!),
    reviewedHeadSha: match[4],
    mergeMethod: "merge",
    authorityEnvelopeHash: "__reconciliation_reference__",
    policyDecisionFingerprint: "__reconciliation_reference__",
    effectiveRisk: 4,
  });
}

export class GitHubMergeReconciliationAdapter implements ProviderReconciliationAdapter {
  readonly provider = GITHUB_PROVIDER;

  constructor(private readonly client: GitHubDevelopmentClient) {}

  async reconcile(
    reference: { provider: string; providerRequestId: string; providerCorrelationId: string },
    signal: AbortSignal,
  ): Promise<ProviderReconciliationResult> {
    if (reference.provider !== this.provider) {
      return { status: "failed", errorCode: "github-provider-reference-mismatch" };
    }
    let args: GitHubMergeArguments;
    try {
      args = parseProviderOperationReference(reference.providerRequestId);
      const pullRequest = await this.client.getPullRequest({
        repository: args.repository,
        pullRequestNumber: args.pullRequestNumber,
        signal,
      });
      if (pullRequest.baseBranch !== args.baseBranch) {
        return {
          status: "failed",
          errorCode: "github-base-changed-new-execution-required",
        };
      }
      if (pullRequest.merged && pullRequest.mergeCommitSha) {
        const commit = await this.client.getCommit({
          repository: args.repository,
          sha: pullRequest.mergeCommitSha,
          signal,
        });
        return {
          status: "succeeded",
          outputDigest: observationDigest({
            repository: args.repository,
            pullRequestNumber: args.pullRequestNumber,
            reviewedHeadSha: args.reviewedHeadSha.toLowerCase(),
            mergeCommitSha: commit.sha.toLowerCase(),
          }),
        };
      }
      if (
        pullRequest.state === "open" &&
        !pullRequest.merged &&
        pullRequest.headSha.toLowerCase() === args.reviewedHeadSha.toLowerCase()
      ) {
        return {
          status: "no-effect",
          evidenceDigest: observationDigest({
            repository: args.repository,
            pullRequestNumber: args.pullRequestNumber,
            state: pullRequest.state,
            merged: false,
            headSha: pullRequest.headSha.toLowerCase(),
          }),
        };
      }
      return {
        status: "failed",
        errorCode:
          pullRequest.headSha.toLowerCase() !== args.reviewedHeadSha.toLowerCase()
            ? "github-head-changed-new-execution-required"
            : "github-merge-not-resumable",
      };
    } catch (error: unknown) {
      return {
        status: "unresolved",
        errorCode:
          error instanceof GitHubRestError
            ? `github-http-${error.status}`
            : "github-observation-failed",
      };
    }
  }
}

export type GitHubPostMergeObservation = {
  status: "passed" | "failed" | "indeterminate";
  reason?: string;
  missionId: string;
  repository: string;
  pullRequestNumber: number;
  reviewedHeadSha: string;
  mergeCommitSha?: string;
  evidenceId: string;
  evidenceDigest: string;
  sourceRef: string;
};

/**
 * Observes provider truth after merge. The returned record is evidence input
 * for the existing Omega evidence/proof mutations; this function neither
 * writes completion state nor treats a model assertion as proof.
 */
export async function observeGitHubPostMerge(
  client: GitHubDevelopmentClient,
  input: {
    missionId: string;
    repository: string;
    pullRequestNumber: number;
    baseBranch: string;
    reviewedHeadSha: string;
    signal: AbortSignal;
  },
): Promise<GitHubPostMergeObservation> {
  const reviewedHeadSha = requiredSha(input.reviewedHeadSha, "Reviewed pull request head");
  const base = {
    missionId: input.missionId.trim(),
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    reviewedHeadSha,
  };
  try {
    const pullRequest = await client.getPullRequest({
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      signal: input.signal,
    });
    if (
      !pullRequest.merged ||
      pullRequest.state !== "closed" ||
      pullRequest.baseBranch !== input.baseBranch ||
      pullRequest.headSha.toLowerCase() !== reviewedHeadSha ||
      !pullRequest.mergeCommitSha
    ) {
      const reason = "post-merge-provider-state-mismatch";
      const evidenceDigest = observationDigest({ ...base, reason, pullRequest });
      return {
        ...base,
        status: "failed",
        reason,
        evidenceId: `github-post-merge-ci:${evidenceDigest}`,
        evidenceDigest,
        sourceRef: `${GITHUB_PROVIDER}:${input.repository}:pull:${input.pullRequestNumber}`,
      };
    }

    const mergeCommitSha = requiredSha(pullRequest.mergeCommitSha, "Merge commit SHA");
    const [commit, checks] = await Promise.all([
      client.getCommit({ repository: input.repository, sha: mergeCommitSha, signal: input.signal }),
      client.getCommitChecks({
        repository: input.repository,
        sha: mergeCommitSha,
        signal: input.signal,
      }),
    ]);
    const normalizedChecks = checks
      .map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const pending = normalizedChecks.some((check) => check.status !== "completed");
    const passingConclusions = new Set(["success", "neutral", "skipped"]);
    const failed = normalizedChecks.some(
      (check) =>
        check.status === "completed" &&
        (check.conclusion === null || !passingConclusions.has(check.conclusion)),
    );
    const status =
      normalizedChecks.length === 0 || pending ? "indeterminate" : failed ? "failed" : "passed";
    const reason =
      normalizedChecks.length === 0
        ? "post-merge-ci-missing"
        : pending
          ? "post-merge-ci-pending"
          : failed
            ? "post-merge-ci-failed"
            : undefined;
    const evidencePayload = {
      ...base,
      baseBranch: input.baseBranch,
      mergeCommitSha: requiredSha(commit.sha, "Observed merge commit SHA"),
      checks: normalizedChecks,
      status,
      ...(reason ? { reason } : {}),
    };
    const evidenceDigest = observationDigest(evidencePayload);
    return {
      ...base,
      status,
      ...(reason ? { reason } : {}),
      mergeCommitSha,
      evidenceId: `github-post-merge-ci:${evidenceDigest}`,
      evidenceDigest,
      sourceRef: `${GITHUB_PROVIDER}:${input.repository}:commit:${mergeCommitSha}`,
    };
  } catch (error: unknown) {
    const reason =
      error instanceof GitHubRestError
        ? `post-merge-observation-http-${error.status}`
        : "post-merge-observation-unresolved";
    const evidenceDigest = observationDigest({ ...base, reason });
    return {
      ...base,
      status: "indeterminate",
      reason,
      evidenceId: `github-post-merge-ci:${evidenceDigest}`,
      evidenceDigest,
      sourceRef: `${GITHUB_PROVIDER}:${input.repository}:pull:${input.pullRequestNumber}`,
    };
  }
}

export function createGitHubMergeToolDefinition(
  client: GitHubDevelopmentClient,
): ToolExecutionDefinition {
  return {
    tool: "github",
    operation: "merge-pull-request",
    externalProvider: GITHUB_PROVIDER,
    schema: githubMergeArguments,
    async preflight(argumentsValue, signal) {
      const args = githubMergeArguments.parse(argumentsValue);
      const pullRequest = await client.getPullRequest({
        repository: args.repository,
        pullRequestNumber: args.pullRequestNumber,
        signal,
      });
      assertMergePreconditions(args, pullRequest);
    },
    async execute(argumentsValue, signal, context) {
      const args = githubMergeArguments.parse(argumentsValue);
      await context.registerProviderAttempt({
        provider: GITHUB_PROVIDER,
        providerRequestId: providerOperationReference(args),
        providerCorrelationId: context.correlationId,
      });
      const result = await client.mergePullRequest({
        repository: args.repository,
        pullRequestNumber: args.pullRequestNumber,
        expectedHeadSha: args.reviewedHeadSha,
        mergeMethod: args.mergeMethod,
        signal,
      });
      if (!result.merged || !result.mergeCommitSha) {
        throw new Error(`GitHub did not prove merge success: ${result.message}`);
      }
      return {
        merged: true,
        repository: args.repository,
        pullRequestNumber: args.pullRequestNumber,
        reviewedHeadSha: args.reviewedHeadSha.toLowerCase(),
        mergeCommitSha: requiredSha(result.mergeCommitSha, "GitHub merge commit SHA"),
      };
    },
  };
}
