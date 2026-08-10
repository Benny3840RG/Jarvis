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
  blocked: ["active", "aborted"],
  partial: ["active", "validating", "aborted"],
  complete: ["retired"],
  aborted: ["initializing", "retired"],
  retired: [],
};

export function canTransitionOmegaMission(
  from: OmegaMissionState,
  to: OmegaMissionState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface CompletionCriterion {
  criterionId: string;
  status: "unverified" | "satisfied" | "failed" | "waived";
  evidenceRefs: readonly string[];
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
  unresolvedActionContracts: number;
  invalidEvidenceRefs: number;
  residualUncertainty: number;
  uncertaintyBudget: number;
}

export interface OmegaCompletionDecision {
  allowed: boolean;
  failures: string[];
}

export function riskRequiresIndependentValidation(risk: OmegaRiskClass): boolean {
  return risk === "R3" || risk === "R4";
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateOmegaCompletion(input: OmegaCompletionInput): OmegaCompletionDecision {
  const failures: string[] = [];
  const criterionIds = new Set(input.criteria.map((criterion) => criterion.criterionId));

  if (input.criteria.length === 0) failures.push("no-acceptance-criteria");
  if (criterionIds.size !== input.criteria.length) {
    failures.push("duplicate-acceptance-criterion-id");
  }

  if (
    input.criteria.some(
      (criterion) => criterion.status !== "satisfied" && criterion.status !== "waived",
    )
  ) {
    failures.push("acceptance-criteria-incomplete");
  }

  if (
    input.criteria.some(
      (criterion) =>
        (criterion.status === "satisfied" || criterion.status === "waived") &&
        criterion.evidenceRefs.length === 0,
    )
  ) {
    failures.push("completed-criterion-missing-evidence");
  }

  if (input.proofs.some((proof) => !criterionIds.has(proof.criterionId))) {
    failures.push("validation-proof-unknown-criterion");
  }

  if (
    input.proofs.some(
      (proof) =>
        (proof.result === "pass" || proof.result === "waived") &&
        proof.evidenceRefs.length === 0,
    )
  ) {
    failures.push("terminal-proof-missing-evidence");
  }

  for (const criterion of input.criteria) {
    const criterionEvidence = new Set(criterion.evidenceRefs);

    if (criterion.status === "satisfied") {
      const passingProofs = input.proofs.filter(
        (proof) => proof.criterionId === criterion.criterionId && proof.result === "pass",
      );

      if (passingProofs.length === 0) {
        failures.push(`criterion-missing-passing-proof:${criterion.criterionId}`);
        continue;
      }

      if (
        !passingProofs.some((proof) =>
          proof.evidenceRefs.some((ref) => criterionEvidence.has(ref)),
        )
      ) {
        failures.push(`criterion-proof-evidence-mismatch:${criterion.criterionId}`);
      }

      if (
        riskRequiresIndependentValidation(input.riskClass) &&
        !passingProofs.some((proof) => proof.independent)
      ) {
        failures.push(`criterion-missing-independent-proof:${criterion.criterionId}`);
      }
    }

    if (criterion.status === "waived") {
      const waiverProofs = input.proofs.filter(
        (proof) => proof.criterionId === criterion.criterionId && proof.result === "waived",
      );
      if (waiverProofs.length === 0) {
        failures.push(`criterion-missing-waiver-proof:${criterion.criterionId}`);
      } else if (
        !waiverProofs.some((proof) =>
          proof.evidenceRefs.some((ref) => criterionEvidence.has(ref)),
        )
      ) {
        failures.push(`criterion-waiver-evidence-mismatch:${criterion.criterionId}`);
      }
      if (riskRequiresIndependentValidation(input.riskClass)) {
        failures.push(`high-risk-criterion-waiver-forbidden:${criterion.criterionId}`);
      }
    }
  }

  if (input.proofs.some((proof) => proof.result === "fail")) {
    failures.push("validation-proof-failed");
  }

  if (!isNonNegativeSafeInteger(input.unresolvedCriticalContradictions)) {
    failures.push("invalid-critical-contradiction-count");
  } else if (input.unresolvedCriticalContradictions > 0) {
    failures.push("critical-evidence-contradiction");
  }

  if (!isNonNegativeSafeInteger(input.unresolvedActionContracts)) {
    failures.push("invalid-action-contract-count");
  } else if (input.unresolvedActionContracts > 0) {
    failures.push("action-contracts-unresolved");
  }

  if (!isNonNegativeSafeInteger(input.invalidEvidenceRefs)) {
    failures.push("invalid-evidence-reference-count");
  } else if (input.invalidEvidenceRefs > 0) {
    failures.push("evidence-invalid-or-expired");
  }

  if (
    !Number.isFinite(input.uncertaintyBudget) ||
    input.uncertaintyBudget < 0 ||
    input.uncertaintyBudget > 1
  ) {
    failures.push("invalid-uncertainty-budget");
  }

  if (
    !Number.isFinite(input.residualUncertainty) ||
    input.residualUncertainty < 0 ||
    input.residualUncertainty > 1
  ) {
    failures.push("invalid-residual-uncertainty");
  } else if (
    Number.isFinite(input.uncertaintyBudget) &&
    input.uncertaintyBudget >= 0 &&
    input.uncertaintyBudget <= 1 &&
    input.residualUncertainty > input.uncertaintyBudget
  ) {
    failures.push("uncertainty-budget-exceeded");
  }

  return { allowed: failures.length === 0, failures };
}
