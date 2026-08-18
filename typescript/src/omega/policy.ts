export type OmegaMissionState =
  | "dormant"
  | "initializing"
  | "active"
  | "validating"
  | "degraded"
  | "recovering"
  | "blocked"
  | "partial"
  | "complete"
  | "aborted"
  | "retired";

export type OmegaRiskClass = "R0" | "R1" | "R2" | "R3" | "R4";

const TRANSITIONS: Readonly<Record<OmegaMissionState, readonly OmegaMissionState[]>> = {
  dormant: ["initializing", "aborted"],
  initializing: ["active", "blocked", "aborted"],
  active: ["validating", "degraded", "blocked", "partial", "aborted"],
  validating: ["active", "partial", "complete", "blocked", "aborted"],
  degraded: ["recovering", "blocked", "aborted"],
  recovering: ["active", "degraded", "blocked", "aborted"],
  blocked: ["aborted"],
  partial: ["active", "validating", "aborted"],
  complete: ["retired"],
  aborted: ["initializing", "retired"],
  retired: [],
};

export function canTransitionOmegaMission(from: OmegaMissionState, to: OmegaMissionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface CompletionCriterion {
  criterionId: string;
}

export interface CompletionProof {
  criterionId: string;
  result: "pass" | "fail" | "inconclusive" | "waived";
  independent: boolean;
  evidenceRefs: readonly string[];
}

export interface OmegaCompletionInput {
  criteria: readonly CompletionCriterion[];
  proofs: readonly CompletionProof[];
  riskClass: OmegaRiskClass;
  unresolvedCriticalContradictions: number;
  unreconciledExternalEffects: number;
  residualUncertainty: number;
  uncertaintyBudget: number;
}

export interface OmegaCompletionDecision {
  allowed: boolean;
  failures: readonly string[];
}

export function riskRequiresIndependentValidation(risk: OmegaRiskClass): boolean {
  return risk === "R3" || risk === "R4";
}

export function evaluateOmegaCompletion(input: OmegaCompletionInput): OmegaCompletionDecision {
  const failures: string[] = [];
  const criterionIds = new Set(input.criteria.map((criterion) => criterion.criterionId));

  if (input.criteria.length === 0) failures.push("no-acceptance-criteria");

  if (criterionIds.size !== input.criteria.length) {
    failures.push("duplicate-acceptance-criterion-id");
  }

  if (input.proofs.some((proof) => !criterionIds.has(proof.criterionId))) {
    failures.push("validation-proof-unknown-criterion");
  }

  if (input.proofs.some((proof) => proof.result === "pass" && proof.evidenceRefs.length === 0)) {
    failures.push("passing-proof-missing-evidence");
  }

  for (const criterion of input.criteria) {
    const passingProofs = input.proofs.filter(
      (proof) => proof.criterionId === criterion.criterionId && proof.result === "pass",
    );

    if (passingProofs.length === 0) {
      failures.push(`criterion-missing-passing-proof:${criterion.criterionId}`);
      continue;
    }

    if (
      riskRequiresIndependentValidation(input.riskClass) &&
      !passingProofs.some((proof) => proof.independent)
    ) {
      failures.push(`criterion-missing-independent-proof:${criterion.criterionId}`);
    }
  }

  if (input.proofs.some((proof) => proof.result === "fail")) {
    failures.push("validation-proof-failed");
  }

  if (input.unresolvedCriticalContradictions > 0) {
    failures.push("critical-evidence-contradiction");
  }

  if (input.unreconciledExternalEffects > 0) {
    failures.push("external-effects-unreconciled");
  }

  if (
    !Number.isFinite(input.residualUncertainty) ||
    input.residualUncertainty < 0 ||
    input.residualUncertainty > 1
  ) {
    failures.push("invalid-residual-uncertainty");
  } else if (input.residualUncertainty > input.uncertaintyBudget) {
    failures.push("uncertainty-budget-exceeded");
  }

  return Object.freeze({
    allowed: failures.length === 0,
    failures: Object.freeze([...failures]),
  });
}
