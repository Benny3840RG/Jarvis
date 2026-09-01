/**
 * Hand-authored mirror of JARVIS_TRANSITIONS.yaml (the canonical machine
 * source). typescript/tests/developmentTransitionRegistryAlignment.test.ts
 * parses the YAML at test time and asserts this object matches it exactly —
 * runtime code does not depend on a YAML parser (js-yaml is dev-only).
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
  | "MERGED"
  | "RECONCILIATION_OPEN"
  | "ABORTED"
  | "COMPLETE";

export type SideEffectClass = "S0" | "S1" | "S2" | "S3" | "S4" | "S5";

export type AuthoritativeCommitter = "controller" | "reconciler" | "omega";

export type ApprovalRule = "none" | "policy" | "existing_claim" | "risk_dependent" | "omega_only";

export type DevelopmentTransitionId =
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
  | "DEV_TRANSITION_MERGED_TO_RECONCILIATION_OPEN"
  | "DEV_TRANSITION_RECONCILIATION_OPEN_TO_MERGED"
  | "DEV_TRANSITION_MERGED_TO_COMPLETE"
  | "DEV_TRANSITION_BUILDING_TO_ABORTED";

export type TransitionDefinition = {
  readonly id: DevelopmentTransitionId;
  readonly domain: "development";
  readonly from: DevelopmentState;
  readonly to: DevelopmentState;
  readonly sideEffectClass: SideEffectClass;
  readonly authoritativeCommitter: AuthoritativeCommitter;
  readonly evaluator: string;
  readonly approval: ApprovalRule;
  readonly reversible: boolean;
  readonly retryTarget: string;
  readonly invariants: readonly string[];
  readonly gates?: readonly string[];
  readonly indeterminateResolution?: {
    readonly opensState: DevelopmentState;
    readonly permittedResolvers: readonly AuthoritativeCommitter[];
    readonly terminalByTimeout: boolean;
    readonly resolutionRequiresExternalObservation: boolean;
  };
};

export const DEVELOPMENT_TRANSITIONS: Readonly<
  Record<DevelopmentTransitionId, TransitionDefinition>
> = Object.freeze({
  DEV_TRANSITION_SPECIFIED_TO_READY: Object.freeze({
    id: "DEV_TRANSITION_SPECIFIED_TO_READY",
    domain: "development",
    from: "SPECIFIED",
    to: "READY",
    sideEffectClass: "S1",
    authoritativeCommitter: "controller",
    evaluator: "deterministic_spec_validator",
    approval: "none",
    reversible: true,
    retryTarget: "validation_operation",
    invariants: Object.freeze(["JARVIS-011", "JARVIS-012", "JARVIS-014"]),
  }),
  DEV_TRANSITION_READY_TO_CLAIMED: Object.freeze({
    id: "DEV_TRANSITION_READY_TO_CLAIMED",
    domain: "development",
    from: "READY",
    to: "CLAIMED",
    sideEffectClass: "S2",
    authoritativeCommitter: "controller",
    evaluator: "claim_lease_gate",
    approval: "policy",
    reversible: true,
    retryTarget: "claim_operation",
    invariants: Object.freeze(["JARVIS-007", "JARVIS-013", "JARVIS-017"]),
  }),
  DEV_TRANSITION_CLAIMED_TO_BUILDING: Object.freeze({
    id: "DEV_TRANSITION_CLAIMED_TO_BUILDING",
    domain: "development",
    from: "CLAIMED",
    to: "BUILDING",
    sideEffectClass: "S2",
    authoritativeCommitter: "controller",
    evaluator: "lease_authority_branch_gate",
    approval: "existing_claim",
    reversible: true,
    retryTarget: "setup_operation",
    invariants: Object.freeze(["JARVIS-007", "JARVIS-013", "JARVIS-016", "JARVIS-017"]),
    gates: Object.freeze([
      "lease_current",
      "worker_matches_lease",
      "worker_authority_subset_of_mission",
      "repository_authorised",
      "branch_authorised",
    ]),
  }),
  DEV_TRANSITION_BUILDING_TO_VERIFYING: Object.freeze({
    id: "DEV_TRANSITION_BUILDING_TO_VERIFYING",
    domain: "development",
    from: "BUILDING",
    to: "VERIFYING",
    sideEffectClass: "S1",
    authoritativeCommitter: "controller",
    evaluator: "build_artifact_gate",
    approval: "none",
    reversible: false,
    retryTarget: "verification_start_operation",
    invariants: Object.freeze(["JARVIS-004", "JARVIS-012", "JARVIS-017"]),
  }),
  DEV_TRANSITION_VERIFYING_TO_REPAIR_REQUIRED: Object.freeze({
    id: "DEV_TRANSITION_VERIFYING_TO_REPAIR_REQUIRED",
    domain: "development",
    from: "VERIFYING",
    to: "REPAIR_REQUIRED",
    sideEffectClass: "S1",
    authoritativeCommitter: "controller",
    evaluator: "verification_policy",
    approval: "none",
    reversible: true,
    retryTarget: "none",
    invariants: Object.freeze(["JARVIS-004", "JARVIS-015"]),
  }),
  DEV_TRANSITION_REPAIR_REQUIRED_TO_BUILDING: Object.freeze({
    id: "DEV_TRANSITION_REPAIR_REQUIRED_TO_BUILDING",
    domain: "development",
    from: "REPAIR_REQUIRED",
    to: "BUILDING",
    sideEffectClass: "S1",
    authoritativeCommitter: "controller",
    evaluator: "repair_authority_gate",
    approval: "none",
    reversible: true,
    retryTarget: "repair_operation",
    invariants: Object.freeze(["JARVIS-007", "JARVIS-016", "JARVIS-017"]),
  }),
  DEV_TRANSITION_VERIFYING_TO_REVIEW: Object.freeze({
    id: "DEV_TRANSITION_VERIFYING_TO_REVIEW",
    domain: "development",
    from: "VERIFYING",
    to: "REVIEW",
    sideEffectClass: "S1",
    authoritativeCommitter: "controller",
    evaluator: "required_checks_gate",
    approval: "none",
    reversible: false,
    retryTarget: "verification_operation",
    invariants: Object.freeze(["JARVIS-004", "JARVIS-011"]),
  }),
  DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED: Object.freeze({
    id: "DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED",
    domain: "development",
    from: "REVIEW",
    to: "REPAIR_REQUIRED",
    sideEffectClass: "S1",
    authoritativeCommitter: "controller",
    evaluator: "review_findings_gate",
    approval: "none",
    reversible: true,
    retryTarget: "none",
    invariants: Object.freeze(["JARVIS-004", "JARVIS-015"]),
  }),
  DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE: Object.freeze({
    id: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE",
    domain: "development",
    from: "REVIEW",
    to: "READY_TO_MERGE",
    sideEffectClass: "S2",
    authoritativeCommitter: "controller",
    evaluator: "review_invariant_gate",
    approval: "policy",
    reversible: true,
    retryTarget: "review_operation",
    invariants: Object.freeze(["JARVIS-001", "JARVIS-011", "JARVIS-018"]),
  }),
  DEV_TRANSITION_READY_TO_MERGE_TO_MERGED: Object.freeze({
    id: "DEV_TRANSITION_READY_TO_MERGE_TO_MERGED",
    domain: "development",
    from: "READY_TO_MERGE",
    to: "MERGED",
    sideEffectClass: "S4",
    authoritativeCommitter: "controller",
    evaluator: "risk_approval_head_integrity_gate",
    approval: "risk_dependent",
    reversible: false,
    retryTarget: "merge_operation",
    indeterminateResolution: Object.freeze({
      opensState: "RECONCILIATION_OPEN",
      permittedResolvers: Object.freeze(["reconciler", "controller"] as const),
      terminalByTimeout: false,
      resolutionRequiresExternalObservation: true,
    }),
    invariants: Object.freeze(["JARVIS-003", "JARVIS-005", "JARVIS-015", "JARVIS-016"]),
  }),
  DEV_TRANSITION_MERGED_TO_RECONCILIATION_OPEN: Object.freeze({
    id: "DEV_TRANSITION_MERGED_TO_RECONCILIATION_OPEN",
    domain: "development",
    from: "MERGED",
    to: "RECONCILIATION_OPEN",
    sideEffectClass: "S1",
    authoritativeCommitter: "reconciler",
    evaluator: "evidence_conflict_gate",
    approval: "policy",
    reversible: true,
    retryTarget: "reconciliation_operation",
    invariants: Object.freeze(["JARVIS-004", "JARVIS-005", "JARVIS-008"]),
  }),
  DEV_TRANSITION_RECONCILIATION_OPEN_TO_MERGED: Object.freeze({
    id: "DEV_TRANSITION_RECONCILIATION_OPEN_TO_MERGED",
    domain: "development",
    from: "RECONCILIATION_OPEN",
    to: "MERGED",
    sideEffectClass: "S1",
    authoritativeCommitter: "reconciler",
    evaluator: "reconciliation_proof_gate",
    approval: "policy",
    reversible: true,
    retryTarget: "reconciliation_operation",
    invariants: Object.freeze(["JARVIS-005", "JARVIS-008"]),
  }),
  DEV_TRANSITION_MERGED_TO_COMPLETE: Object.freeze({
    id: "DEV_TRANSITION_MERGED_TO_COMPLETE",
    domain: "development",
    from: "MERGED",
    to: "COMPLETE",
    sideEffectClass: "S2",
    authoritativeCommitter: "omega",
    evaluator: "omega_completion_policy",
    approval: "omega_only",
    reversible: false,
    retryTarget: "omega_evaluation_operation",
    gates: Object.freeze([
      "omega_identity_verified",
      "completion_evaluation_complete",
      "zero_blocking_contradictions",
      "reconciliation_closed",
      "current_evidence_satisfies_criteria",
    ]),
    invariants: Object.freeze(["JARVIS-001", "JARVIS-004", "JARVIS-008", "JARVIS-018"]),
  }),
  DEV_TRANSITION_BUILDING_TO_ABORTED: Object.freeze({
    id: "DEV_TRANSITION_BUILDING_TO_ABORTED",
    domain: "development",
    from: "BUILDING",
    to: "ABORTED",
    sideEffectClass: "S2",
    authoritativeCommitter: "controller",
    evaluator: "abort_policy",
    approval: "policy",
    reversible: false,
    retryTarget: "abort_cleanup_operation",
    invariants: Object.freeze(["JARVIS-005", "JARVIS-012", "JARVIS-017"]),
  }),
});
