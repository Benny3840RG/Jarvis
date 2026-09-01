/**
 * Minimal model resource governance (JARVIS Phase 1, Task 10).
 *
 * Jarvis's own AI calls consume real resources and should not be spent
 * blindly. This module gives Jarvis operational awareness of what model it
 * is using and what that costs — not human-style self-awareness, and not a
 * universal cost optimizer. Per the build's own scoping instructions,
 * this implements only: trusted model identity/capability metadata, a
 * routing policy, usage telemetry aggregation, simple bounded budgets, and
 * bounded/recorded escalation.
 *
 * Deliberately independent of the transition kernel: nothing here can
 * grant, deny, or influence a transition. `checkCognitiveBudget`'s result
 * type has no notion of transition admissibility at all — budget pressure
 * can make Jarvis stop spending model calls, but it can never weaken
 * authority, verification, evidence, or ΩΣ completion requirements
 * (handover "Cognitive budgets": "Do not fake completion to save tokens").
 *
 * REUSE note: this repo already has `src/totality/totalityQuota.ts`
 * (`TotalityQuota`), a real lease-acquire/release budget for the Totality
 * reasoning boundary (byte/token/concurrency/cost-window limits). This
 * module deliberately does not reuse that class directly — it is scoped to
 * a single reasoning boundary/time-window, not to a Development mission's
 * cumulative usage across many calls — but mirrors its pattern (bounded,
 * typed rejection reasons; simple config; no framework dependency) rather
 * than inventing an unrelated shape.
 */

export type ModelCapabilityClass =
  "FAST_GENERAL" | "DEEP_REASONING" | "CODING" | "VISION" | "LONG_CONTEXT";

/**
 * The source for a monetary figure. Estimated figures may guide an
 * optimisation, but they never prove a spend ceiling has been respected.
 */
export type CostProvenance = "VERIFIED_PROVIDER" | "ESTIMATED" | "UNAVAILABLE";

export type ModelIdentity = {
  readonly provider: string;
  readonly model: string;
};

export type ModelProfile = ModelIdentity & {
  readonly capabilityClasses: readonly ModelCapabilityClass[];
  readonly contextWindow?: number;
  readonly estimatedInputCostPerMToken?: number;
  readonly estimatedOutputCostPerMToken?: number;
  readonly costProvenance: CostProvenance;
  readonly typicalLatencyMs?: number;
  readonly supportsTools?: boolean;
  readonly supportsVision?: boolean;
  readonly supportsStructuredOutput?: boolean;
};

/**
 * Trusted runtime registry — the sole source of model capability truth.
 * Routing only ever resolves a model via lookup here; a caller-constructed
 * profile-shaped object is never trusted on its own (handover: "Do not
 * trust a model's prose claim about its own capabilities when provider/
 * runtime metadata exists"). Identifiers mirror the two providers already
 * wired for Totality reasoning (`src/integrations/openai/totalityReasoner.ts`,
 * `.../gemini/totalityReasoner.ts`) without importing their private
 * `DEFAULT_MODEL` constants.
 *
 * These specific cost/latency/context-window figures are illustrative
 * Phase-1 placeholders, not verified real-world pricing or benchmarks — an
 * operator must curate accurate profile data before this feeds a real
 * routing decision with real money attached.
 */
export const MODEL_PROFILES: readonly ModelProfile[] = Object.freeze([
  Object.freeze({
    provider: "openai",
    model: "gpt-5.6-mini",
    capabilityClasses: Object.freeze(["FAST_GENERAL"] as const),
    contextWindow: 128_000,
    estimatedInputCostPerMToken: 0.5,
    estimatedOutputCostPerMToken: 1.5,
    costProvenance: "ESTIMATED",
    typicalLatencyMs: 600,
    supportsTools: true,
    supportsStructuredOutput: true,
  }),
  Object.freeze({
    provider: "openai",
    model: "gpt-5.6",
    capabilityClasses: Object.freeze(["FAST_GENERAL", "CODING", "DEEP_REASONING"] as const),
    contextWindow: 256_000,
    estimatedInputCostPerMToken: 3,
    estimatedOutputCostPerMToken: 12,
    costProvenance: "ESTIMATED",
    typicalLatencyMs: 2200,
    supportsTools: true,
    supportsVision: true,
    supportsStructuredOutput: true,
  }),
  Object.freeze({
    provider: "gemini",
    model: "gemini-2.5-flash",
    capabilityClasses: Object.freeze(["FAST_GENERAL", "LONG_CONTEXT"] as const),
    contextWindow: 1_000_000,
    estimatedInputCostPerMToken: 0.3,
    estimatedOutputCostPerMToken: 1.2,
    costProvenance: "ESTIMATED",
    typicalLatencyMs: 700,
    supportsTools: true,
    supportsVision: true,
  }),
]);

export type CognitiveRequirement = {
  readonly minimumCapability: ModelCapabilityClass;
  readonly expectedContextTokens?: number;
  readonly latencyPriority?: "LOW" | "NORMAL" | "HIGH";
  readonly reasoningDepth?: "LIGHT" | "MEDIUM" | "DEEP";
  readonly maximumEstimatedCost?: number;
  /**
   * Advisory only. A model may propose a lower capability class to save
   * cost, but routing must never honour a suggestion below
   * `minimumCapability` — the requirement is a floor, not a starting point,
   * mirroring the transition kernel's effective-risk floor.
   */
  readonly modelSuggestedCapability?: ModelCapabilityClass;
};

export type RoutingOptions = {
  /**
   * Identities are only registry lookup keys. Candidate-supplied capability,
   * cost, latency, and support fields are deliberately ignored.
   */
  readonly candidates: readonly ModelIdentity[];
};

export type RoutingResult =
  | { readonly routed: true; readonly profile: ModelProfile }
  | {
      readonly routed: false;
      readonly reason:
        | "NO_CANDIDATE_SATISFIES_REQUIREMENT"
        | "UNTRUSTED_CANDIDATE"
        | "COST_PROVENANCE_INSUFFICIENT";
    };

export function resolveTrustedModelProfile(candidate: ModelIdentity): ModelProfile | undefined {
  return MODEL_PROFILES.find(
    (trusted) => trusted.provider === candidate.provider && trusted.model === candidate.model,
  );
}

/**
 * Selects the least-expensive candidate satisfying `minimumCapability`.
 * `modelSuggestedCapability` never lowers the floor — it is accepted as
 * input but has no effect on which capability class is actually required.
 */
export function routeModelForRequirement(
  requirement: CognitiveRequirement,
  options: RoutingOptions,
): RoutingResult {
  const trustedCandidates = options.candidates.map(resolveTrustedModelProfile);
  if (trustedCandidates.some((candidate) => candidate === undefined)) {
    return { routed: false, reason: "UNTRUSTED_CANDIDATE" };
  }

  const capabilityQualifying = trustedCandidates
    .filter((candidate): candidate is ModelProfile => candidate !== undefined)
    .filter((candidate) => {
      if (!candidate.capabilityClasses.includes(requirement.minimumCapability)) return false;
      if (
        requirement.expectedContextTokens !== undefined &&
        candidate.contextWindow !== undefined &&
        candidate.contextWindow < requirement.expectedContextTokens
      ) {
        return false;
      }
      return true;
    });

  const qualifying = capabilityQualifying.filter((candidate) => {
    if (requirement.maximumEstimatedCost === undefined) return true;
    return (
      candidate.costProvenance === "VERIFIED_PROVIDER" &&
      candidate.estimatedInputCostPerMToken !== undefined &&
      candidate.estimatedInputCostPerMToken <= requirement.maximumEstimatedCost
    );
  });

  if (qualifying.length === 0) {
    if (
      requirement.maximumEstimatedCost !== undefined &&
      capabilityQualifying.some((candidate) => candidate.costProvenance !== "VERIFIED_PROVIDER")
    ) {
      return { routed: false, reason: "COST_PROVENANCE_INSUFFICIENT" };
    }
    return { routed: false, reason: "NO_CANDIDATE_SATISFIES_REQUIREMENT" };
  }

  const cheapest = qualifying.reduce((best, candidate) => {
    const bestCost = best.estimatedInputCostPerMToken ?? Number.POSITIVE_INFINITY;
    const candidateCost = candidate.estimatedInputCostPerMToken ?? Number.POSITIVE_INFINITY;
    return candidateCost < bestCost ? candidate : best;
  });

  return { routed: true, profile: cheapest };
}

export type ModelInvocationRecord = {
  readonly provider: string;
  readonly model: string;
  readonly workUnitId: string;
  readonly purpose: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly contextSize?: number;
  readonly estimatedCost: number;
  readonly costProvenance: CostProvenance;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly failureReason?: string;
  readonly escalationDecision?: "none" | "escalated" | "downgraded";
  readonly escalationReason?: EscalationReason;
  readonly missionId?: string;
  readonly workerId?: string;
  readonly occurredAt: string;
  readonly correlationId: string;
};

export type MissionUsageSummary = {
  readonly totalCalls: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalEstimatedCost: number;
  readonly totalRetries: number;
  readonly totalLatencyMs: number;
  readonly totalEscalations: number;
  readonly unnecessaryRepeatCalls: number;
  readonly modelDistribution: readonly string[];
};

/**
 * Pure aggregation over durable invocation records — never a running
 * mutable counter — so mission usage totals are always re-derivable from
 * history, matching the same "derive from durable history" principle used
 * elsewhere in this kernel (approval-exercise, projection state).
 */
export function aggregateModelUsage(
  records: readonly ModelInvocationRecord[],
): MissionUsageSummary {
  const modelDistribution = new Set<string>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalEstimatedCost = 0;
  let totalRetries = 0;
  let totalLatencyMs = 0;
  let totalEscalations = 0;
  let unnecessaryRepeatCalls = 0;
  const workUnitsSeen = new Set<string>();

  for (const record of records) {
    modelDistribution.add(`${record.provider}/${record.model}`);
    totalInputTokens += record.inputTokens;
    totalOutputTokens += record.outputTokens;
    totalEstimatedCost += record.estimatedCost;
    totalRetries += record.retryCount;
    totalLatencyMs += record.latencyMs;
    if (record.escalationDecision === "escalated") totalEscalations += 1;
    const repeatKey = `${record.workUnitId}\u0000${record.purpose}`;
    if (workUnitsSeen.has(repeatKey) && record.retryCount > 0) unnecessaryRepeatCalls += 1;
    workUnitsSeen.add(repeatKey);
  }

  return Object.freeze({
    totalCalls: records.length,
    totalInputTokens,
    totalOutputTokens,
    totalEstimatedCost,
    totalRetries,
    totalLatencyMs,
    totalEscalations,
    unnecessaryRepeatCalls,
    modelDistribution: Object.freeze([...modelDistribution]),
  });
}

export type CognitiveBudget = {
  readonly maxEstimatedSpend?: number;
  readonly maxModelCalls?: number;
  readonly maxExpensiveEscalations?: number;
  readonly maxRetryAttempts?: number;
  readonly maxContextTokens?: number;
};

export type BudgetCheckReason =
  | "MAX_ESTIMATED_SPEND_EXCEEDED"
  | "MAX_MODEL_CALLS_EXCEEDED"
  | "MAX_RETRY_ATTEMPTS_EXCEEDED"
  | "MAX_CONTEXT_TOKENS_EXCEEDED"
  | "COST_PROVENANCE_INSUFFICIENT";

/**
 * Deliberately has no field resembling transition/execution admissibility
 * — this type cannot be mistaken for or substituted into a
 * TransitionEvaluation. Budget pressure can only ever stop further model
 * spend; it has no vocabulary for granting or denying governed authority.
 */
export type BudgetCheckResult = {
  readonly withinBudget: boolean;
  readonly reasons: readonly BudgetCheckReason[];
};

export function checkCognitiveBudget(
  budget: CognitiveBudget,
  usageSoFar: readonly ModelInvocationRecord[],
): BudgetCheckResult {
  const summary = aggregateModelUsage(usageSoFar);
  const reasons: BudgetCheckReason[] = [];

  if (
    budget.maxEstimatedSpend !== undefined &&
    usageSoFar.some((record) => record.costProvenance !== "VERIFIED_PROVIDER")
  ) {
    reasons.push("COST_PROVENANCE_INSUFFICIENT");
  } else if (
    budget.maxEstimatedSpend !== undefined &&
    summary.totalEstimatedCost > budget.maxEstimatedSpend
  ) {
    reasons.push("MAX_ESTIMATED_SPEND_EXCEEDED");
  }
  if (budget.maxModelCalls !== undefined && summary.totalCalls > budget.maxModelCalls) {
    reasons.push("MAX_MODEL_CALLS_EXCEEDED");
  }
  if (
    budget.maxRetryAttempts !== undefined &&
    usageSoFar.some((record) => record.retryCount >= budget.maxRetryAttempts!)
  ) {
    reasons.push("MAX_RETRY_ATTEMPTS_EXCEEDED");
  }
  if (
    budget.maxContextTokens !== undefined &&
    usageSoFar.some((record) => record.inputTokens > budget.maxContextTokens!)
  ) {
    reasons.push("MAX_CONTEXT_TOKENS_EXCEEDED");
  }

  return Object.freeze({ withinBudget: reasons.length === 0, reasons: Object.freeze(reasons) });
}

/**
 * Legitimate triggers a model may cite when recommending escalation to a
 * more capable/expensive model. Jarvis decides whether to honour it —
 * this type only records the claimed reason, it doesn't grant escalation.
 */
export type EscalationReason =
  | "repeated_verification_failure"
  | "unresolved_contradiction"
  | "security_or_architecture_sensitive"
  | "capability_unavailable_in_current_model"
  | "context_too_large_for_current_model"
  | "low_confidence_high_consequence";

export type EscalationRequest = {
  readonly priorEscalationCount: number;
  readonly reason: EscalationReason;
};

export type EscalationDisposition =
  | { readonly permitted: true; readonly reason: EscalationReason }
  | { readonly permitted: false; readonly disallowedReason: "ESCALATION_LIMIT_EXCEEDED" };

/**
 * Every escalation must carry a reason (handover: "Every escalation should
 * carry a reason") and is bounded by the mission's cognitive budget so a
 * model cannot escalate indefinitely chasing a better answer.
 */
export function deriveEscalationDisposition(
  budget: CognitiveBudget,
  request: EscalationRequest,
): EscalationDisposition {
  if (
    budget.maxExpensiveEscalations !== undefined &&
    request.priorEscalationCount >= budget.maxExpensiveEscalations
  ) {
    return { permitted: false, disallowedReason: "ESCALATION_LIMIT_EXCEEDED" };
  }
  return { permitted: true, reason: request.reason };
}
