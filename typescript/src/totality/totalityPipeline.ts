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
  reason(
    request: TotalityRequest,
    context: TotalityReasoningContext,
  ): Promise<TotalityReasoningDraft>;
}

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
  constructor(
    private readonly reasoner: TotalityReasoner,
    private readonly journal: TotalityJournal,
    private readonly now: () => Date = () => new Date(),
    private readonly quota: TotalityQuota = new TotalityQuota(resolveTotalityQuotaConfig()),
  ) {}

  async run(request: TotalityRequest): Promise<TotalityResponse<TotalityReasoningResult>> {
    const routing = routeTotalityTask({
      taskType: request.taskType,
      outputStyle: request.outputStyle,
      domainContext: request.domainContext,
    });
    assertRequestAuthority(request, routing);

    const project =
      request.projectId === null ? null : await this.journal.getProjectContext(request.projectId);
    if (request.projectId !== null && project === null) {
      throw new Error("Project context does not exist.");
    }

    const lease: TotalityQuotaLease = this.quota.acquire(request);
    try {
      const proposedAt = this.now().toISOString();
      const reasoning = await this.reasoner.reason(request, {
        project,
        proposedAt,
        maxOutputTokens: this.quota.maxOutputTokens,
      });
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
}
