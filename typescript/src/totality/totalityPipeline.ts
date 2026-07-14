import type {
  TotalityError,
  TotalityRequest,
  TotalityResponse,
} from "../runtime/totalityContracts.js";
import { assertRequestAuthority } from "../runtime/totalityContracts.js";
import { routeTotalityTask } from "../runtime/totalityPolicy.js";
import { validateTotalityResult } from "../runtime/validation.js";

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
  };
}

export interface TotalityReasoner {
  reason(request: TotalityRequest): Promise<TotalityReasoningDraft>;
}

export interface TotalityJournal {
  recordValidation(input: {
    requestId: string;
    projectId: string | null;
    report: TotalityResponse["validation"];
  }): Promise<void>;
  appendAudit(input: {
    requestId: string;
    projectId: string | null;
    eventType: string;
    actor: "agent";
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export type TotalityReasoningResult = {
  answer: string;
  responseId: string | null;
};

function blockedErrors(blockingFailures: string[]): TotalityError[] {
  return blockingFailures.map((message) => ({
    code: "VALIDATION_BLOCKED",
    message,
    retryable: false,
  }));
}

export class TotalityPipeline {
  constructor(
    private readonly reasoner: TotalityReasoner,
    private readonly journal: TotalityJournal,
  ) {}

  async run(
    request: TotalityRequest,
  ): Promise<TotalityResponse<TotalityReasoningResult>> {
    const routing = routeTotalityTask({
      taskType: request.taskType,
      outputStyle: request.outputStyle,
      domainContext: request.domainContext,
    });
    assertRequestAuthority(request, routing);

    const reasoning = await this.reasoner.reason(request);
    const validation = validateTotalityResult({
      routing,
      assumptions: reasoning.draft.assumptions,
      unsupportedClaims: reasoning.draft.unsupportedClaims,
      contradictions: reasoning.draft.contradictions,
      hazards: reasoning.draft.risks,
      controls: reasoning.draft.controls,
    });
    const status = validation.passed ? "completed" : "blocked";

    await this.journal.recordValidation({
      requestId: request.requestId,
      projectId: request.projectId,
      report: validation,
    });
    await this.journal.appendAudit({
      requestId: request.requestId,
      projectId: request.projectId,
      eventType: `totality.reasoning.${status}`,
      actor: "agent",
      payload: {
        responseId: reasoning.responseId,
        primaryMode: routing.primaryMode,
        supportingModes: routing.supportingModes,
        riskLevel: routing.permission.riskLevel,
        validationPassed: validation.passed,
        blockingFailureCount: validation.blockingFailures.length,
      },
    });

    return {
      requestId: request.requestId,
      status,
      routing,
      result: validation.passed
        ? { answer: reasoning.draft.answer, responseId: reasoning.responseId }
        : null,
      assumptions: reasoning.draft.assumptions,
      unknowns: reasoning.draft.unknowns,
      risks: reasoning.draft.risks,
      validation,
      memoryUpdates: [],
      toolActions: [],
      errors: validation.passed ? [] : blockedErrors(validation.blockingFailures),
    };
  }
}
