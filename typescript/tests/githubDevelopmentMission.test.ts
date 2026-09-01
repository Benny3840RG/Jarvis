import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolAction } from "../src/actions/toolActions.js";
import {
  InMemoryToolExecutionReceiptStore,
  ToolExecutionService,
  fingerprintToolEffect,
  type SingleUseConsumptionClaimStore,
  type ToolExecutionReceipt,
} from "../src/actions/toolExecution.js";
import {
  createGitHubMergeToolDefinition,
  GitHubMergeReconciliationAdapter,
  observeGitHubPostMerge,
  validateGitHubDevelopmentIssue,
  type GitHubDevelopmentClient,
} from "../src/development/githubDevelopment.js";
import type {
  CompleteExternalAttemptInput,
  ExternalExecutionScope,
  ExternalReconciliationClaim,
  ExternalReconciliationEnvelope,
  ExternalReconciliationRecord,
  ExternalReconciliationStore,
  MarkExternalIndeterminateInput,
  ProviderReconciliationResult,
  RegisterExternalAttemptInput,
} from "../src/reconciliation/externalReconciliation.js";

const reviewedHeadSha = "a".repeat(40);
const mergeCommitSha = "b".repeat(40);

function action(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "github-merge-action-1",
    requestId: "github-merge-request-1",
    projectId: "jarvis-phase-1",
    baseRevision: 1,
    state: "approved",
    tool: "github",
    operation: "merge-pull-request",
    arguments: {
      subjectId: "jarvis-phase-1",
      transitionId: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
      repository: "Benny3840RG/Jarvis",
      pullRequestNumber: 42,
      baseBranch: "main",
      reviewedHeadSha,
      mergeMethod: "squash",
      authorityEnvelopeHash: "authority-envelope-hash-1",
      policyDecisionFingerprint: "development-policy-fingerprint:v1",
      effectiveRisk: 4,
    },
    rationale: "Merge the independently reviewed Phase 1 pull request.",
    requiredAuthority: "T3",
    destructive: true,
    idempotencyKey: "github-merge-proposal-1",
    proposedBy: "agent",
    approvedBy: "user",
    consumptionPolicy: "single-use",
    approvalExpiryPolicy: "non-expiring",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    approvedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

class ClaimStore implements SingleUseConsumptionClaimStore {
  calls = 0;

  async claim(_action: ToolAction, claimId: string) {
    this.calls += 1;
    return { claimed: true, claimId };
  }
}

class ReconciliationStore implements ExternalReconciliationStore {
  readonly order: string[];
  envelope: ExternalReconciliationEnvelope | null = null;

  constructor(order: string[]) {
    this.order = order;
  }

  async getByScope(scope: ExternalExecutionScope) {
    if (
      this.envelope &&
      this.envelope.reconciliation.effectFingerprint !== scope.effectFingerprint
    ) {
      throw new Error("effect fingerprint collision");
    }
    return this.envelope;
  }

  async registerAttempt(input: RegisterExternalAttemptInput) {
    this.order.push("intent");
    const now = Date.now();
    const reconciliation: ExternalReconciliationRecord = {
      ...input,
      provider: input.reference.provider,
      providerRequestId: input.reference.providerRequestId,
      providerCorrelationId: input.reference.providerCorrelationId,
      state: "observing",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.envelope = { reconciliation, receipt: null };
    return reconciliation;
  }

  async markIndeterminate(
    _input: MarkExternalIndeterminateInput,
  ): Promise<ExternalReconciliationEnvelope> {
    throw new Error("not used");
  }

  async completeAttempt(input: CompleteExternalAttemptInput) {
    const current = this.envelope?.reconciliation;
    if (!current) throw new Error("missing attempt");
    const reconciliation: ExternalReconciliationRecord = {
      ...current,
      state: "resolved",
      terminalStatus: "succeeded",
      receiptKey: input.receiptKey,
      receiptId: input.receipt.receiptId,
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
    };
    this.envelope = { reconciliation, receipt: input.receipt };
    return this.envelope;
  }

  async claimNext(): Promise<ExternalReconciliationClaim | null> {
    return null;
  }

  async resolveClaim(_input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    result: Exclude<ProviderReconciliationResult, { status: "unresolved" }>;
  }): Promise<ToolExecutionReceipt> {
    throw new Error("not used");
  }

  async releaseClaim(): Promise<ExternalReconciliationRecord> {
    throw new Error("not used");
  }

  async cleanup() {
    return false;
  }
}

function client(overrides: Partial<GitHubDevelopmentClient> = {}): GitHubDevelopmentClient {
  return {
    async getIssue() {
      return {
        number: 1,
        state: "open",
        title: "Mission",
        body: "Objective\n\nAcceptance criteria\n- tests pass",
        labels: ["jarvis-development"],
        isPullRequest: false,
      };
    },
    async getPullRequest() {
      return {
        number: 42,
        state: "open",
        merged: false,
        draft: false,
        baseBranch: "main",
        headSha: reviewedHeadSha,
      };
    },
    async mergePullRequest() {
      return { merged: true, mergeCommitSha, message: "merged" };
    },
    async getCommit() {
      return { sha: mergeCommitSha };
    },
    async getCommitChecks() {
      return [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "security", status: "completed", conclusion: "success" },
      ];
    },
    ...overrides,
  };
}

describe("GitHub governed development mission", () => {
  it("validates an open labelled issue into a deterministic development mission", async () => {
    const mission = await validateGitHubDevelopmentIssue(
      client({
        async getIssue() {
          return {
            number: 101,
            state: "open",
            title: "Harden merge authority",
            body: "## Objective\nBind merge to exact SHA.\n\n## Acceptance Criteria\n- moved SHA is rejected\n- tests pass",
            labels: ["jarvis-development"],
            isPullRequest: false,
          };
        },
      }),
      {
        repository: "Benny3840RG/Jarvis",
        issueNumber: 101,
        signal: new AbortController().signal,
      },
    );

    assert.equal(mission.objective, "Bind merge to exact SHA.");
    assert.match(mission.acceptanceCriteria, /moved SHA is rejected/);
    assert.match(mission.issueEvidenceDigest, /^[0-9a-f]{64}$/);
  });

  it("rejects a PR masquerading as a development issue", async () => {
    await assert.rejects(
      validateGitHubDevelopmentIssue(
        client({
          async getIssue() {
            return {
              number: 101,
              state: "open",
              title: "Not an issue",
              body: "## Objective\nNo.\n## Acceptance Criteria\nNo.",
              labels: ["jarvis-development"],
              isPullRequest: true,
            };
          },
        }),
        {
          repository: "Benny3840RG/Jarvis",
          issueNumber: 101,
          signal: new AbortController().signal,
        },
      ),
      /must be an issue, not a PR/,
    );
  });

  it("rejects a moved head before durable intent, so gate rejection does not exercise approval", async () => {
    const claims = new ClaimStore();
    let mergeCalls = 0;
    const definition = createGitHubMergeToolDefinition(
      client({
        async getPullRequest() {
          return {
            number: 42,
            state: "open",
            merged: false,
            draft: false,
            baseBranch: "main",
            headSha: "c".repeat(40),
          };
        },
        async mergePullRequest() {
          mergeCalls += 1;
          return { merged: true, mergeCommitSha, message: "merged" };
        },
      }),
    );
    const executor = new ToolExecutionService(
      [definition],
      new InMemoryToolExecutionReceiptStore(),
      new ReconciliationStore([]),
      claims,
    );

    const result = await executor.execute({
      action: action(),
      authority: "T3",
      idempotencyKey: "operation-1",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "precondition-failed");
    assert.equal(claims.calls, 0);
    assert.equal(mergeCalls, 0);
  });

  it("commits provider intent before calling GitHub and binds the exact reviewed SHA", async () => {
    const order: string[] = [];
    const reconciliations = new ReconciliationStore(order);
    const definition = createGitHubMergeToolDefinition(
      client({
        async mergePullRequest(input) {
          order.push("provider");
          assert.equal(input.expectedHeadSha, reviewedHeadSha);
          assert.equal(input.mergeMethod, "squash");
          return { merged: true, mergeCommitSha, message: "merged" };
        },
      }),
    );
    const executor = new ToolExecutionService(
      [definition],
      new InMemoryToolExecutionReceiptStore(),
      reconciliations,
      new ClaimStore(),
    );

    const result = await executor.execute({
      action: action(),
      authority: "T3",
      idempotencyKey: "operation-1",
      approvalId: "approval-1",
      policyVersion: "development-policy:v1",
      correlationId: "correlation-1",
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(order, ["intent", "provider"]);
    assert.equal(reconciliations.envelope?.reconciliation.provider, "github-rest-v1");
    assert.match(
      reconciliations.envelope?.reconciliation.providerRequestId ?? "",
      /Benny3840RG\/Jarvis.*42.*aaaaaaaa/,
    );
  });

  it("distinguishes proven non-occurrence from success and changed-effect failure", async () => {
    const unchanged = new GitHubMergeReconciliationAdapter(client());
    const reference = {
      provider: "github-rest-v1",
      providerRequestId: `github-rest-v1:Benny3840RG/Jarvis:pull:42:base:main:sha:${reviewedHeadSha}`,
      providerCorrelationId: "correlation-1",
    };
    const noEffect = await unchanged.reconcile(reference, new AbortController().signal);
    assert.equal(noEffect.status, "no-effect");

    const succeeded = new GitHubMergeReconciliationAdapter(
      client({
        async getPullRequest() {
          return {
            number: 42,
            state: "closed",
            merged: true,
            draft: false,
            baseBranch: "main",
            headSha: reviewedHeadSha,
            mergeCommitSha,
          };
        },
      }),
    );
    const success = await succeeded.reconcile(reference, new AbortController().signal);
    assert.equal(success.status, "succeeded");

    const moved = new GitHubMergeReconciliationAdapter(
      client({
        async getPullRequest() {
          return {
            number: 42,
            state: "open",
            merged: false,
            draft: false,
            baseBranch: "main",
            headSha: "c".repeat(40),
          };
        },
      }),
    );
    const changed = await moved.reconcile(reference, new AbortController().signal);
    assert.deepEqual(changed, {
      status: "failed",
      errorCode: "github-head-changed-new-execution-required",
    });
  });

  it("resumes the same exercised operation only after reconciliation proves no effect", async () => {
    const order: string[] = [];
    const reconciliations = new ReconciliationStore(order);
    const approvedAction = action();
    const effectFingerprint = fingerprintToolEffect(approvedAction);
    const now = Date.now();
    const reconciliation: ExternalReconciliationRecord = {
      reconciliationId: "reconciliation-1",
      executionKey: "external:operation-1",
      actionId: approvedAction.actionId,
      requestId: approvedAction.requestId,
      projectId: approvedAction.projectId,
      tool: approvedAction.tool,
      operation: approvedAction.operation,
      idempotencyKey: "operation-1",
      actionFingerprint: "action-fingerprint-1",
      effectFingerprint,
      provider: "github-rest-v1",
      providerRequestId: `github-rest-v1:Benny3840RG/Jarvis:pull:42:base:main:sha:${reviewedHeadSha}`,
      providerCorrelationId: "correlation-1",
      receiptKey: "external:operation-1",
      receiptId: "receipt-no-effect",
      state: "resolved",
      terminalStatus: "no-effect",
      resolutionDigest: "no-effect-evidence",
      attemptCount: 1,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      resolvedAt: now,
    };
    reconciliations.envelope = {
      reconciliation,
      receipt: {
        receiptId: "receipt-no-effect",
        actionId: approvedAction.actionId,
        requestId: approvedAction.requestId,
        projectId: approvedAction.projectId,
        idempotencyKey: "operation-1",
        actionFingerprint: "action-fingerprint-1",
        effectFingerprint,
        tool: approvedAction.tool,
        operation: approvedAction.operation,
        actor: approvedAction.proposedBy,
        policyVersion: "development-policy:v1",
        correlationId: "correlation-1",
        source: "reconciliation",
        provider: "github-rest-v1",
        status: "failed",
        errorCode: "provider-failed",
        providerErrorCode: "provider-proved-no-effect",
        startedAt: new Date(now - 1_000).toISOString(),
        completedAt: new Date(now).toISOString(),
      },
    };
    let mergeCalls = 0;
    const definition = createGitHubMergeToolDefinition(
      client({
        async mergePullRequest() {
          mergeCalls += 1;
          order.push("provider");
          return { merged: true, mergeCommitSha, message: "merged" };
        },
      }),
    );
    const executor = new ToolExecutionService(
      [definition],
      new InMemoryToolExecutionReceiptStore(),
      reconciliations,
      new ClaimStore(),
    );

    const resumed = await executor.execute({
      action: approvedAction,
      authority: "T3",
      idempotencyKey: "operation-1",
    });
    assert.equal(resumed.status, "succeeded");
    assert.equal(mergeCalls, 1);

    const changed = await executor.execute({
      action: action({
        arguments: { ...approvedAction.arguments, reviewedHeadSha: "c".repeat(40) },
      }),
      authority: "T3",
      idempotencyKey: "operation-1",
    });
    assert.equal(changed.status, "blocked");
    assert.equal(changed.errorCode, "fingerprint-mismatch");
    assert.equal(mergeCalls, 1);
  });

  it("blocks a concurrent resume loser before another provider call", async () => {
    const reconciliations = new ReconciliationStore([]);
    reconciliations.registerAttempt = async () => {
      throw new Error(
        "External execution operation already has an attempt in progress or resolved.",
      );
    };
    let mergeCalls = 0;
    const executor = new ToolExecutionService(
      [
        createGitHubMergeToolDefinition(
          client({
            async mergePullRequest() {
              mergeCalls += 1;
              return { merged: true, mergeCommitSha, message: "merged" };
            },
          }),
        ),
      ],
      new InMemoryToolExecutionReceiptStore(),
      reconciliations,
      new ClaimStore(),
    );

    const result = await executor.execute({
      action: action(),
      authority: "T3",
      idempotencyKey: "operation-1",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "retry-blocked-pending-reconciliation");
    assert.equal(mergeCalls, 0);
  });

  it("produces deterministic post-merge evidence only after the merge commit and CI are observed", async () => {
    const observation = await observeGitHubPostMerge(
      client({
        async getPullRequest() {
          return {
            number: 42,
            state: "closed",
            merged: true,
            draft: false,
            baseBranch: "main",
            headSha: reviewedHeadSha,
            mergeCommitSha,
          };
        },
      }),
      {
        missionId: "jarvis-phase-1",
        repository: "Benny3840RG/Jarvis",
        pullRequestNumber: 42,
        baseBranch: "main",
        reviewedHeadSha,
        signal: new AbortController().signal,
      },
    );

    assert.equal(observation.status, "passed");
    assert.equal(observation.mergeCommitSha, mergeCommitSha);
    assert.match(observation.evidenceId, /^github-post-merge-ci:/);
    assert.match(observation.evidenceDigest, /^[0-9a-f]{64}$/);
  });

  it("never emits passing post-merge evidence when required CI fails", async () => {
    const observation = await observeGitHubPostMerge(
      client({
        async getPullRequest() {
          return {
            number: 42,
            state: "closed",
            merged: true,
            draft: false,
            baseBranch: "main",
            headSha: reviewedHeadSha,
            mergeCommitSha,
          };
        },
        async getCommitChecks() {
          return [{ name: "test", status: "completed", conclusion: "failure" }];
        },
      }),
      {
        missionId: "jarvis-phase-1",
        repository: "Benny3840RG/Jarvis",
        pullRequestNumber: 42,
        baseBranch: "main",
        reviewedHeadSha,
        signal: new AbortController().signal,
      },
    );

    assert.equal(observation.status, "failed");
    assert.equal(observation.reason, "post-merge-ci-failed");
  });
});
