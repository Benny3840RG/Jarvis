import { createHash } from "node:crypto";

import {
  materializeReasoningMemoryProposal,
  type MaterializedReasoningMemoryProposal,
  type ReasoningMemoryProposalDraft,
} from "../memory/reasoningMemoryProposals.js";
import type {
  TotalityError,
  TotalityRequest,
  TotalityResponse,
} from "../runtime/totalityContracts.js";
import { assertRequestAuthority } from "../runtime/totalityContracts.js";
import { routeTotalityTask } from "../runtime/totalityPolicy.js";
import { validateTotalityResult, type ValidationReport } from "../runtime/validation.js";
import {
  TotalityQuota,
  resolveTotalityQuotaConfig,
  type TotalityQuotaLease,
} from "./totalityQuota.js";
import {
  asCallerDisconnected,
  assertExplicitDurability,
  signalForWork,
  throwIfCallerDisconnected,
  TotalityCallerDisconnected,
  type TotalityDelegatedJob,
} from "./callerLifetime.js";

export type TotalityProjectContext = {
  projectId: string;
  projectName: string;
  projectType: string;
  status: "planned" | "active" | "blocked" | "completed" | "archived";
  revision: number;
  domains: string[];
  summary: string;
  updatedAt: string;
};

export type TotalityReasoningContext = {
  project: TotalityProjectContext | null;
  proposedAt: string;
  maxOutputTokens?: number;
};

export interface TotalityReasoningDraft {
  responseId: string | null;
  modelUsage?: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
  draft: {
    answer: string;
    assumptions: string[];
    unknowns: string[];
    risks: string[];
    controls: string[];
    unsupportedClaims: string[];
    contradictions: string[];
    memoryProposals: ReasoningMemoryProposalDraft[];
    memoryRationale: string;
  };
}

export interface TotalityReasoner {
  /** Return the exact serialized body used for provider dispatch, including all overhead. */
  serializeRequest(request: TotalityRequest, context: TotalityReasoningContext): string;
  reason(
    request: TotalityRequest,
    context: TotalityReasoningContext,
    signal?: AbortSignal,
  ): Promise<TotalityReasoningDraft>;
}

export type TotalityRunOptions = {
  /** In-process caller lifetime. Never read from the request body. */
  signal?: AbortSignal;
  delegations?: readonly TotalityDelegatedJob[];
};

export interface TotalityJournal {
  getProjectContext(projectId: string): Promise<TotalityProjectContext | null>;
  commitOutcome(input: {
    requestId: string;
    projectId: string | null;
    report: TotalityResponse["validation"];
    eventType: string;
    actor: "agent";
    payload: Record<string, unknown>;
    memoryProposal?: {
      changeSetId: string;
      expectedRevision: number;
      records: MaterializedReasoningMemoryProposal["records"];
      rationale: string;
    };
  }): Promise<{ memoryChangeSetId: string | null }>;
}

export type TotalityReasoningResult = {
  answer: string;
  responseId: string | null;
  memoryChangeSetId: string | null;
  memoryProposalCount: number;
};

function blockedErrors(blockingFailures: string[]): TotalityError[] {
  return blockingFailures.map((message) => ({
    code: "VALIDATION_BLOCKED",
    message,
    retryable: false,
  }));
}

function memoryValidation(
  report: ValidationReport,
  input: {
    proposalCount: number;
    projectAvailable: boolean;
    failure: string | null;
  },
): ValidationReport {
  const blockingFailures = [...report.blockingFailures];
  let status: "pass" | "fail" = "pass";
  let message: string | undefined;

  if (input.failure) {
    status = "fail";
    message = input.failure;
    blockingFailures.push(input.failure);
  } else if (input.proposalCount > 0 && !input.projectAvailable) {
    status = "fail";
    message = "Reasoning memory proposals require an authoritative project context.";
    blockingFailures.push(message);
  }

  return {
    passed: blockingFailures.length === 0,
    checks: [
      ...report.checks,
      {
        id: "MEMORY_PROPOSAL_BOUNDARY",
        status,
        ...(message === undefined ? {} : { message }),
      },
    ],
    warnings: report.warnings,
    blockingFailures,
  };
}

function reasoningChangeSetId(projectId: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(`${projectId}\u0000${requestId}`)
    .digest("hex")
    .slice(0, 24);
  return `reasoning-${digest}`;
}

function emptyMemoryProposal(): MaterializedReasoningMemoryProposal {
  return { records: [], updates: [], rationale: "" };
}

export class TotalityPipeline {
  private readonly admittedDurableWork: Promise<void>[] = [];

  constructor(
    private readonly reasoner: TotalityReasoner,
    private readonly journal: TotalityJournal,
    private readonly now: () => Date = () => new Date(),
    private readonly quota: TotalityQuota = new TotalityQuota(resolveTotalityQuotaConfig()),
  ) {}

  /** Durable jobs admitted by earlier turns. Caller disconnect does not settle these. */
  get detachedDurableWork(): readonly Promise<void>[] {
    return this.admittedDurableWork;
  }

  async run(
    request: TotalityRequest,
    options: TotalityRunOptions = {},
  ): Promise<TotalityResponse<TotalityReasoningResult>> {
    const routing = routeTotalityTask({
      taskType: request.taskType,
      outputStyle: request.outputStyle,
      domainContext: request.domainContext,
    });
    assertRequestAuthority(request, routing);
    const delegations = options.delegations ?? [];
    assertExplicitDurability(delegations);
    const signal = options.signal;
    throwIfCallerDisconnected(signal);

    const project =
      request.projectId === null ? null : await this.journal.getProjectContext(request.projectId);
    if (request.projectId !== null && project === null) {
      throw new Error("Project context does not exist.");
    }
    throwIfCallerDisconnected(signal);

    const proposedAt = this.now().toISOString();
    const context: TotalityReasoningContext = {
      project,
      proposedAt,
      maxOutputTokens: this.quota.maxOutputTokens,
    };
    const serializedProviderRequest = this.reasoner.serializeRequest(request, context);
    throwIfCallerDisconnected(signal);
    const lease: TotalityQuotaLease = this.quota.acquire(request, serializedProviderRequest);
    try {
      const requestBound = this.admitDelegations(delegations, signal);
      const [reasoning] = await Promise.all([
        observeCaller(signal, () => this.reasoner.reason(request, context, signal)),
        ...requestBound,
      ]);
      throwIfCallerDisconnected(signal);
      let memoryProposal = emptyMemoryProposal();
      let memoryProposalFailure: string | null = null;

      if (reasoning.draft.memoryProposals.length > 0 && project !== null) {
        try {
          memoryProposal = materializeReasoningMemoryProposal({
            projectId: project.projectId,
            requestId: request.requestId,
            proposedAt,
            drafts: reasoning.draft.memoryProposals,
            rationale: reasoning.draft.memoryRationale,
          });
        } catch (error: unknown) {
          memoryProposalFailure = error instanceof Error ? error.message : String(error);
        }
      }

      const validation = memoryValidation(
        validateTotalityResult({
          routing,
          assumptions: reasoning.draft.assumptions,
          unsupportedClaims: reasoning.draft.unsupportedClaims,
          contradictions: reasoning.draft.contradictions,
          hazards: reasoning.draft.risks,
          controls: reasoning.draft.controls,
        }),
        {
          proposalCount: reasoning.draft.memoryProposals.length,
          projectAvailable: project !== null,
          failure: memoryProposalFailure,
        },
      );
      const status = validation.passed ? "completed" : "blocked";

      const committed = await this.journal.commitOutcome({
        requestId: request.requestId,
        projectId: request.projectId,
        report: validation,
        eventType: `totality.reasoning.${status}`,
        actor: "agent",
        payload: {
          responseId: reasoning.responseId,
          primaryMode: routing.primaryMode,
          supportingModes: routing.supportingModes,
          riskLevel: routing.permission.riskLevel,
          validationPassed: validation.passed,
          blockingFailureCount: validation.blockingFailures.length,
          memoryProposalCount: reasoning.draft.memoryProposals.length,
          ...(reasoning.modelUsage ? { modelUsage: reasoning.modelUsage } : {}),
        },
        ...(validation.passed && project !== null && memoryProposal.records.length > 0
          ? {
              memoryProposal: {
                changeSetId: reasoningChangeSetId(project.projectId, request.requestId),
                expectedRevision: project.revision,
                records: memoryProposal.records,
                rationale: memoryProposal.rationale,
              },
            }
          : {}),
      });

      return {
        requestId: request.requestId,
        status,
        routing,
        result: validation.passed
          ? {
              answer: reasoning.draft.answer,
              responseId: reasoning.responseId,
              memoryChangeSetId: committed.memoryChangeSetId,
              memoryProposalCount: memoryProposal.records.length,
            }
          : null,
        assumptions: reasoning.draft.assumptions,
        unknowns: reasoning.draft.unknowns,
        risks: reasoning.draft.risks,
        validation,
        memoryUpdates: validation.passed ? memoryProposal.updates : [],
        toolActions: [],
        errors: validation.passed ? [] : blockedErrors(validation.blockingFailures),
      };
    } finally {
      lease.release();
    }
  }

  private admitDelegations(
    delegations: readonly TotalityDelegatedJob[],
    caller: AbortSignal | undefined,
  ): Array<Promise<void>> {
    // Re-check at admit time. A disconnect during quota admission must not
    // start durable work that the earlier check had already allowed.
    throwIfCallerDisconnected(caller);
    const requestBound: Array<Promise<void>> = [];
    for (const job of delegations) {
      if (job.durable) {
        throwIfCallerDisconnected(caller);
        const work = Promise.resolve().then(() => job.run(signalForWork("durable", caller)));
        this.admittedDurableWork.push(work);
        void work.then(
          () => undefined,
          () => undefined,
        );
        continue;
      }
      const signal = signalForWork("request-bound", caller);
      requestBound.push(observeCaller(signal, () => job.run(signal)));
    }
    return requestBound;
  }
}

function observeCaller<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const promise = run();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const settleWork = () => {
      void promise.then(
        (value) => {
          if (signal.aborted) finish(new TotalityCallerDisconnected());
          else finish(undefined, value);
        },
        (error: unknown) => finish(asCallerDisconnected(signal, error)),
      );
    };
    const onAbort = () => {
      settleWork();
      // A provider or parse failure in the same turn must win over this fallback.
      abortTimer = setTimeout(() => finish(new TotalityCallerDisconnected()), 0);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    settleWork();
  });
}
