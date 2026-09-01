/**
 * Hand-authored runtime mirror of root TRANSITIONS.yaml, the sole
 * machine-readable development transition authority. The alignment test
 * parses that contract and compares every field below at test time; runtime
 * code deliberately has no production YAML-parser dependency.
 */

export type DevelopmentState =
  | "IDEA"
  | "SPECIFIED"
  | "READY"
  | "CLAIMED"
  | "BUILDING"
  | "VERIFYING"
  | "REPAIR_REQUIRED"
  | "REVIEW"
  | "READY_TO_MERGE"
  | "INDETERMINATE"
  | "MERGED"
  | "CONTRADICTED"
  | "FAILED"
  | "ABORTED"
  | "COMPLETE";

export type SideEffectClass = "S0" | "S1" | "S2" | "S3" | "S4" | "S5";
export type AuthoritativeCommitter = "controller" | "omega";
export type ApprovalRule = "none" | "policy" | "existing_claim" | "risk_dependent" | "omega_only";

export type DevelopmentTransitionId =
  | "DEV_TRANSITION_IDEA_TO_SPECIFIED"
  | "DEV_TRANSITION_SPECIFIED_TO_READY"
  | "DEV_TRANSITION_READY_TO_CLAIMED"
  | "DEV_TRANSITION_CLAIMED_TO_BUILDING"
  | "DEV_TRANSITION_BUILDING_TO_VERIFYING"
  | "DEV_TRANSITION_VERIFYING_TO_REPAIR_REQUIRED"
  | "DEV_TRANSITION_REPAIR_REQUIRED_TO_BUILDING"
  | "DEV_TRANSITION_VERIFYING_TO_REVIEW"
  | "DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED"
  | "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE"
  | "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED"
  | "DEV_TRANSITION_READY_TO_MERGE_TO_INDETERMINATE"
  | "DEV_TRANSITION_INDETERMINATE_TO_MERGED"
  | "DEV_TRANSITION_INDETERMINATE_TO_READY_TO_MERGE"
  | "DEV_TRANSITION_INDETERMINATE_TO_CONTRADICTED"
  | "DEV_TRANSITION_INDETERMINATE_TO_FAILED"
  | "DEV_TRANSITION_MERGED_TO_COMPLETE"
  | "DEV_TRANSITION_REPAIR_REQUIRED_TO_FAILED"
  | "DEV_TRANSITION_ANY_ACTIVE_TO_ABORTED";

type Contract = Readonly<Record<string, unknown>>;

export type TransitionDefinition = {
  readonly id: DevelopmentTransitionId;
  readonly domain: "development";
  readonly sources: readonly DevelopmentState[];
  readonly target: DevelopmentState;
  readonly sideEffectClass: SideEffectClass;
  readonly requestedBy: readonly string[];
  readonly evaluatedBy: readonly string[];
  readonly authorisedBy: readonly string[];
  readonly committedBy: string;
  readonly gates: readonly string[];
  readonly evidenceRequired: readonly string[];
  readonly operationRetry: Contract;
  readonly reconciliation?: Contract;
  readonly constitutionalInvariants: readonly string[];
  readonly evaluator: string;
  /* Compatibility aliases retained for the established kernel API. */
  readonly from: DevelopmentState;
  readonly to: DevelopmentState;
  readonly authoritativeCommitter: AuthoritativeCommitter;
  readonly approval: ApprovalRule;
  readonly reversible: boolean;
  readonly retryTarget: string;
  readonly invariants: readonly string[];
};

type DefinitionInput = Omit<
  TransitionDefinition,
  | "domain"
  | "from"
  | "to"
  | "authoritativeCommitter"
  | "approval"
  | "reversible"
  | "retryTarget"
  | "invariants"
> & {
  readonly authoritativeCommitter?: AuthoritativeCommitter;
  readonly approval?: ApprovalRule;
  readonly reversible?: boolean;
};

function frozenList<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function define(input: DefinitionInput): TransitionDefinition {
  const retryTarget =
    input.operationRetry.allowed === true ? `${input.id.toLowerCase()}_operation` : "none";
  return Object.freeze({
    ...input,
    domain: "development" as const,
    sources: frozenList(input.sources),
    requestedBy: frozenList(input.requestedBy),
    evaluatedBy: frozenList(input.evaluatedBy),
    authorisedBy: frozenList(input.authorisedBy),
    gates: frozenList(input.gates),
    evidenceRequired: frozenList(input.evidenceRequired),
    operationRetry: Object.freeze({ ...input.operationRetry }),
    ...(input.reconciliation ? { reconciliation: Object.freeze({ ...input.reconciliation }) } : {}),
    constitutionalInvariants: frozenList(input.constitutionalInvariants),
    from: input.sources[0]!,
    to: input.target,
    authoritativeCommitter:
      input.authoritativeCommitter ??
      (input.committedBy === "omega_completion_authority" ? "omega" : "controller"),
    approval:
      input.approval ??
      (input.committedBy === "omega_completion_authority"
        ? "omega_only"
        : input.sideEffectClass === "S4"
          ? "risk_dependent"
          : "none"),
    reversible: input.reversible ?? input.sideEffectClass !== "S4",
    retryTarget,
    invariants: frozenList(input.constitutionalInvariants),
  });
}

const controller = ["development_controller"] as const;
const transitionGate = ["development_controller"] as const;

export const DEVELOPMENT_TRANSITIONS: Readonly<
  Record<DevelopmentTransitionId, TransitionDefinition>
> = Object.freeze({
  DEV_TRANSITION_IDEA_TO_SPECIFIED: define({
    id: "DEV_TRANSITION_IDEA_TO_SPECIFIED",
    sources: ["IDEA"],
    target: "SPECIFIED",
    sideEffectClass: "S1",
    requestedBy: controller,
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: [
      "issue_exists",
      "objective_non_empty",
      "acceptance_criteria_non_empty",
      "invariant_ids_valid",
    ],
    evidenceRequired: ["validated_issue_spec"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-011", "JARVIS-012", "JARVIS-014"],
    evaluator: "deterministic_issue_spec_validator",
  }),
  DEV_TRANSITION_SPECIFIED_TO_READY: define({
    id: "DEV_TRANSITION_SPECIFIED_TO_READY",
    sources: ["SPECIFIED"],
    target: "READY",
    sideEffectClass: "S1",
    requestedBy: controller,
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: [
      "dependencies_satisfied",
      "risk_class_assigned",
      "capability_envelope_defined",
      "required_verification_policy_defined",
    ],
    evidenceRequired: ["dependency_evaluation", "authority_envelope"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-011", "JARVIS-012", "JARVIS-014"],
    evaluator: "deterministic_readiness_gate",
  }),
  DEV_TRANSITION_READY_TO_CLAIMED: define({
    id: "DEV_TRANSITION_READY_TO_CLAIMED",
    sources: ["READY"],
    target: "CLAIMED",
    sideEffectClass: "S2",
    requestedBy: ["worker_allocator"],
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: ["no_active_claim_exists", "worker_is_eligible", "capability_envelope_covers_issue"],
    evidenceRequired: ["execution_claim", "lease_record"],
    operationRetry: {
      allowed: true,
      max_attempts: 3,
      backoff: "bounded_exponential",
      retry_only_if: ["claim_write_conclusively_failed"],
    },
    constitutionalInvariants: ["JARVIS-007", "JARVIS-013", "JARVIS-017"],
    evaluator: "deterministic_claim_lease_gate",
    approval: "policy",
  }),
  DEV_TRANSITION_CLAIMED_TO_BUILDING: define({
    id: "DEV_TRANSITION_CLAIMED_TO_BUILDING",
    sources: ["CLAIMED"],
    target: "BUILDING",
    sideEffectClass: "S2",
    requestedBy: ["development_worker"],
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: [
      "execution_claim_valid",
      "lease_active",
      "lease_bound_to_worker",
      "authority_envelope_covers_target_branch",
      "expected_subject_version_matches",
    ],
    evidenceRequired: ["execution_claim", "lease_record", "branch_metadata"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-007", "JARVIS-013", "JARVIS-016", "JARVIS-017"],
    evaluator: "deterministic_lease_authority_branch_gate",
    approval: "existing_claim",
  }),
  DEV_TRANSITION_BUILDING_TO_VERIFYING: define({
    id: "DEV_TRANSITION_BUILDING_TO_VERIFYING",
    sources: ["BUILDING"],
    target: "VERIFYING",
    sideEffectClass: "S2",
    requestedBy: ["development_worker"],
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: [
      "execution_claim_valid",
      "lease_active",
      "implementation_artifact_exists",
      "build_receipt_recorded",
    ],
    evidenceRequired: ["implementation_commit", "build_receipt"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-004", "JARVIS-012", "JARVIS-017"],
    evaluator: "deterministic_build_artifact_gate",
  }),
  DEV_TRANSITION_VERIFYING_TO_REPAIR_REQUIRED: define({
    id: "DEV_TRANSITION_VERIFYING_TO_REPAIR_REQUIRED",
    sources: ["VERIFYING"],
    target: "REPAIR_REQUIRED",
    sideEffectClass: "S1",
    requestedBy: ["verifier"],
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: ["verification_run_complete", "verification_failed_conclusively"],
    evidenceRequired: ["verification_receipt", "failure_findings"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-004", "JARVIS-015"],
    evaluator: "deterministic_verification_failure_gate",
  }),
  DEV_TRANSITION_REPAIR_REQUIRED_TO_BUILDING: define({
    id: "DEV_TRANSITION_REPAIR_REQUIRED_TO_BUILDING",
    sources: ["REPAIR_REQUIRED"],
    target: "BUILDING",
    sideEffectClass: "S2",
    requestedBy: controller,
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: ["repair_attempt_budget_remaining", "valid_worker_claim_available"],
    evidenceRequired: ["repair_work_package", "execution_claim"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-007", "JARVIS-016", "JARVIS-017"],
    evaluator: "deterministic_repair_authority_gate",
  }),
  DEV_TRANSITION_VERIFYING_TO_REVIEW: define({
    id: "DEV_TRANSITION_VERIFYING_TO_REVIEW",
    sources: ["VERIFYING"],
    target: "REVIEW",
    sideEffectClass: "S1",
    requestedBy: ["verifier"],
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: ["required_verification_checks_passed", "no_blocking_verification_findings"],
    evidenceRequired: ["verification_receipts"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-004", "JARVIS-011"],
    evaluator: "deterministic_verification_success_gate",
  }),
  DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED: define({
    id: "DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED",
    sources: ["REVIEW"],
    target: "REPAIR_REQUIRED",
    sideEffectClass: "S1",
    requestedBy: ["reviewer"],
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: ["independent_review_complete", "blocking_review_findings_present"],
    evidenceRequired: ["review_receipt", "review_findings"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-004", "JARVIS-015"],
    evaluator: "deterministic_review_findings_gate",
  }),
  DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE: define({
    id: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE",
    sources: ["REVIEW"],
    target: "READY_TO_MERGE",
    sideEffectClass: "S2",
    requestedBy: ["reviewer"],
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: [
      "independent_review_passed",
      "constitutional_invariants_passed",
      "risk_classification_current",
      "required_approval_policy_satisfied_for_readiness",
    ],
    evidenceRequired: ["review_receipt", "invariant_check_receipt", "risk_evaluation"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-001", "JARVIS-011", "JARVIS-018"],
    evaluator: "deterministic_review_readiness_gate",
    approval: "policy",
  }),
  DEV_TRANSITION_READY_TO_MERGE_TO_MERGED: define({
    id: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
    sources: ["READY_TO_MERGE"],
    target: "MERGED",
    sideEffectClass: "S4",
    requestedBy: ["merge_executor"],
    evaluatedBy: transitionGate,
    authorisedBy: ["development_controller", "operator"],
    committedBy: "development_controller",
    gates: [
      "merge_execution_claim_valid",
      "branch_head_matches_approved_sha",
      "risk_policy_satisfied",
      "operator_approval_present_when_required",
      "provider_receipt_proves_merge",
    ],
    evidenceRequired: [
      "merge_execution_claim",
      "approval_record_if_required",
      "provider_merge_receipt",
    ],
    operationRetry: {
      allowed: true,
      max_attempts: 2,
      backoff: "bounded_exponential",
      retry_only_if: ["previous_attempt_conclusively_failed_before_external_effect"],
      on_ambiguous_external_result: {
        transition_to: "INDETERMINATE",
        blindly_retry_external_effect: false,
      },
    },
    constitutionalInvariants: ["JARVIS-003", "JARVIS-005", "JARVIS-015", "JARVIS-016"],
    evaluator: "deterministic_merge_authority_gate",
  }),
  DEV_TRANSITION_READY_TO_MERGE_TO_INDETERMINATE: define({
    id: "DEV_TRANSITION_READY_TO_MERGE_TO_INDETERMINATE",
    sources: ["READY_TO_MERGE"],
    target: "INDETERMINATE",
    sideEffectClass: "S2",
    requestedBy: ["merge_executor"],
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: ["merge_operation_was_attempted", "outcome_not_provable_from_current_evidence"],
    evidenceRequired: ["ambiguous_execution_receipt"],
    operationRetry: { allowed: false },
    reconciliation: {
      required: true,
      deadline_policy: "bounded_reconciliation_window",
      no_timeout_auto_failure: true,
    },
    constitutionalInvariants: ["JARVIS-004", "JARVIS-005", "JARVIS-015"],
    evaluator: "deterministic_indeterminate_outcome_gate",
  }),
  DEV_TRANSITION_INDETERMINATE_TO_MERGED: define({
    id: "DEV_TRANSITION_INDETERMINATE_TO_MERGED",
    sources: ["INDETERMINATE"],
    target: "MERGED",
    sideEffectClass: "S2",
    requestedBy: controller,
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: ["reconciliation_complete", "external_effect_proven"],
    evidenceRequired: ["reconciliation_receipt", "provider_merge_evidence"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-004", "JARVIS-005", "JARVIS-008"],
    evaluator: "deterministic_reconciliation_success_gate",
  }),
  DEV_TRANSITION_INDETERMINATE_TO_READY_TO_MERGE: define({
    id: "DEV_TRANSITION_INDETERMINATE_TO_READY_TO_MERGE",
    sources: ["INDETERMINATE"],
    target: "READY_TO_MERGE",
    sideEffectClass: "S2",
    requestedBy: controller,
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: [
      "reconciliation_complete",
      "external_effect_proven_not_to_have_occurred",
      "retry_budget_remaining",
      "approval_still_current",
    ],
    evidenceRequired: ["reconciliation_receipt", "provider_non_merge_evidence"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-005", "JARVIS-015", "JARVIS-016"],
    evaluator: "deterministic_reconciliation_non_effect_gate",
  }),
  DEV_TRANSITION_INDETERMINATE_TO_CONTRADICTED: define({
    id: "DEV_TRANSITION_INDETERMINATE_TO_CONTRADICTED",
    sources: ["INDETERMINATE"],
    target: "CONTRADICTED",
    sideEffectClass: "S2",
    requestedBy: controller,
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: [
      "reconciliation_window_exhausted_or_conflicting_authoritative_evidence_present",
      "contradiction_record_created",
    ],
    evidenceRequired: ["contradiction_record", "reconciliation_attempts"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-004", "JARVIS-005", "JARVIS-008"],
    evaluator: "deterministic_contradiction_gate",
  }),
  DEV_TRANSITION_INDETERMINATE_TO_FAILED: define({
    id: "DEV_TRANSITION_INDETERMINATE_TO_FAILED",
    sources: ["INDETERMINATE"],
    target: "FAILED",
    sideEffectClass: "S2",
    requestedBy: controller,
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: [
      "reconciliation_complete",
      "external_effect_conclusively_failed",
      "no_safe_retry_path_exists",
    ],
    evidenceRequired: ["reconciliation_receipt", "conclusive_failure_evidence"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-005", "JARVIS-015"],
    evaluator: "deterministic_failure_gate",
  }),
  DEV_TRANSITION_MERGED_TO_COMPLETE: define({
    id: "DEV_TRANSITION_MERGED_TO_COMPLETE",
    sources: ["MERGED"],
    target: "COMPLETE",
    sideEffectClass: "S2",
    requestedBy: controller,
    evaluatedBy: ["omega_completion_authority"],
    authorisedBy: ["omega_completion_authority"],
    committedBy: "omega_completion_authority",
    gates: [
      "post_merge_observation_complete",
      "required_acceptance_evidence_current",
      "no_unresolved_critical_contradictions",
      "completion_policy_passed",
      "event_schema_compatible_with_reducer",
    ],
    evidenceRequired: [
      "merge_receipt",
      "post_merge_ci_receipt",
      "acceptance_validation_proofs",
      "contradiction_resolution_state",
    ],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-001", "JARVIS-004", "JARVIS-008", "JARVIS-018"],
    evaluator: "omega_completion_policy",
  }),
  DEV_TRANSITION_REPAIR_REQUIRED_TO_FAILED: define({
    id: "DEV_TRANSITION_REPAIR_REQUIRED_TO_FAILED",
    sources: ["REPAIR_REQUIRED"],
    target: "FAILED",
    sideEffectClass: "S2",
    requestedBy: controller,
    evaluatedBy: transitionGate,
    authorisedBy: controller,
    committedBy: "development_controller",
    gates: ["repair_attempt_budget_exhausted", "failure_is_conclusive"],
    evidenceRequired: ["repair_attempt_history", "conclusive_failure_evidence"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-004", "JARVIS-015"],
    evaluator: "deterministic_repair_exhaustion_gate",
  }),
  DEV_TRANSITION_ANY_ACTIVE_TO_ABORTED: define({
    id: "DEV_TRANSITION_ANY_ACTIVE_TO_ABORTED",
    sources: [
      "SPECIFIED",
      "READY",
      "CLAIMED",
      "BUILDING",
      "VERIFYING",
      "REPAIR_REQUIRED",
      "REVIEW",
      "READY_TO_MERGE",
      "INDETERMINATE",
      "CONTRADICTED",
    ],
    target: "ABORTED",
    sideEffectClass: "S2",
    requestedBy: ["development_controller", "operator"],
    evaluatedBy: transitionGate,
    authorisedBy: ["development_controller", "operator"],
    committedBy: "development_controller",
    gates: ["abort_authority_present", "no_unreconciled_external_effect_can_be_hidden_by_abort"],
    evidenceRequired: ["abort_reason", "reconciliation_state_if_external_effect_attempted"],
    operationRetry: { allowed: false },
    constitutionalInvariants: ["JARVIS-005", "JARVIS-012", "JARVIS-017"],
    evaluator: "deterministic_abort_safety_gate",
    approval: "policy",
  }),
});
