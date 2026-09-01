/**
 * Development transition kernel (JARVIS Phase 1, Task 3).
 *
 * Pure, deterministic admissibility evaluation for the Development domain
 * transition grammar defined in JARVIS_TRANSITIONS.yaml/.md. This module
 * decides whether a requested transition is legally admissible; it never
 * persists state, calls a provider, or commits an event. The trusted commit
 * boundary (Task 4: events.ts/reducer.ts) is the only place authoritative
 * state actually advances, and it re-validates through this same evaluator
 * before appending an event.
 *
 * Per JARVIS-002/JARVIS_EVENTS.md's commit-time authority rule, actor-role
 * fields on a request (e.g. `committedBy.actorType === "omega"`) are
 * self-reported evidence, not authentication — `OMEGA_COMMITTER_REQUIRED`
 * below is a labelling/audit check, not authentication.
 *
 * Real ΩΣ completion authority already exists (`../omega/policy.js` +
 * `convex/omegaMissions.ts#transition`, gated by `requireOwner`). Per
 * JARVIS-018 this kernel must not invent a parallel completion-authority
 * concept, so `MERGED -> COMPLETE` admissibility is decided by calling the
 * *real*, reused `evaluateOmegaCompletion` (pure, zero-dependency) rather
 * than trusting a caller-supplied "verified" flag. This module cannot and
 * does not authenticate the caller as Omega — the trusted commit boundary
 * that will eventually back this domain (Task 7's Convex integration, per
 * Task 13 "ΩΣ completion integration") must route the actual COMPLETE
 * commit through `omegaMissions.transition` itself; this kernel's job ends
 * at "is the supplied Omega completion input itself satisfied."
 */

import { evaluateOmegaCompletion, type OmegaCompletionInput } from "../omega/policy.js";
import {
  DEVELOPMENT_TRANSITIONS,
  type ApprovalRule,
  type AuthoritativeCommitter,
  type DevelopmentState,
  type DevelopmentTransitionId,
  type TransitionDefinition,
} from "./transitionRegistry.js";

export type { DevelopmentState, DevelopmentTransitionId, TransitionDefinition };
export { DEVELOPMENT_TRANSITIONS };

export type ActorType =
  | "operator"
  | "control-plane"
  | "controller"
  | "worker"
  | "model"
  | "provider"
  | "omega"
  | "reconciler";

export type ActorRef = {
  readonly actorType: ActorType;
  readonly actorId: string;
};

export type CapabilityEnvelope = {
  readonly repositories: readonly string[];
  readonly branches: readonly string[];
  readonly externalEffects: readonly string[];
  readonly maxRiskClass: number;
};

export type LeaseInfo = {
  readonly leaseId: string;
  readonly workerId: string;
  readonly expiresAt: string;
};

export type ApprovalRef = {
  readonly approvalId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly maxRiskClass: number;
};

export type MergeOperationOutcome = "MERGED" | "REJECTED" | "FAILED" | "INDETERMINATE";

export type MergeEvidence = {
  readonly reviewedHeadSha: string;
  readonly currentHeadSha: string;
  readonly reconciledMergedCommitSha?: string;
  /**
   * The provider-observed outcome of the merge operation itself, distinct
   * from head-integrity. Per JARVIS-005/JARVIS-015, an INDETERMINATE
   * outcome must never be coerced into MERGED (nor into a distinct FAILED
   * state — Development has no such state; ambiguity must instead route
   * through RECONCILIATION_OPEN). Omitted/`"MERGED"` proceeds to the
   * ordinary head-integrity check below.
   */
  readonly operationOutcome?: MergeOperationOutcome;
};

/**
 * Authoritative external observation gathered during reconciliation
 * (JARVIS_EVENTS.md "INDETERMINATE resolution contract"). Elapsed time is
 * never itself an observation — `externallyObserved` must be true and
 * `observedOutcome` must actually establish `"MERGED"` before
 * RECONCILIATION_OPEN -> MERGED is admissible.
 */
export type ReconciliationEvidence = {
  readonly externallyObserved: boolean;
  readonly observedOutcome: "MERGED" | "NOT_MERGED" | "STILL_UNKNOWN";
  readonly observationSource: string;
};

export type TransitionRequest = {
  readonly transitionId: DevelopmentTransitionId;
  readonly from: DevelopmentState;
  readonly to: DevelopmentState;
  readonly now: string;
  readonly requestedBy: ActorRef;
  readonly evaluatedBy?: ActorRef;
  readonly authorisedBy?: ActorRef;
  readonly committedBy: ActorRef;
  readonly workerId?: string;
  readonly lease?: LeaseInfo;
  readonly missionAuthority?: CapabilityEnvelope;
  readonly workerAuthority?: CapabilityEnvelope;
  readonly branch?: string;
  readonly repository?: string;
  readonly riskClass?: number;
  readonly approval?: ApprovalRef;
  readonly mergeEvidence?: MergeEvidence;
  readonly reconciliationEvidence?: ReconciliationEvidence;
  /**
   * Real input to the reused `evaluateOmegaCompletion` policy — criteria,
   * proofs, risk class, unresolved contradictions/external effects, and
   * residual uncertainty, exactly as `convex/omegaMissions.ts#transition`
   * derives them from durable rows before calling the same function.
   */
  readonly omegaCompletionInput?: OmegaCompletionInput;
  readonly expectedSubjectVersion?: number;
  readonly currentSubjectVersion?: number;
};

export type RejectionDescriptor = {
  readonly transitionId: DevelopmentTransitionId;
  readonly sourceState: DevelopmentState;
  readonly requestedBy: ActorRef;
  readonly reasonCodes: readonly string[];
};

export type TransitionEvaluation = {
  readonly allowed: boolean;
  readonly outcome: "ALLOWED" | "REJECTED";
  readonly reasons: readonly string[];
  readonly rejection?: RejectionDescriptor;
};

const MIN_APPROVAL_REQUIRED_RISK_CLASS = 2;

function allowed(): TransitionEvaluation {
  return Object.freeze({ allowed: true, outcome: "ALLOWED", reasons: Object.freeze([]) });
}

function rejected(
  request: TransitionRequest,
  reasonCodes: string | readonly string[],
): TransitionEvaluation {
  const reasons = Object.freeze(
    Array.isArray(reasonCodes) ? [...reasonCodes] : [reasonCodes as string],
  );
  return Object.freeze({
    allowed: false,
    outcome: "REJECTED",
    reasons,
    rejection: Object.freeze({
      transitionId: request.transitionId,
      sourceState: request.from,
      requestedBy: request.requestedBy,
      reasonCodes: reasons,
    }),
  });
}

function isSubset(worker: readonly string[], mission: readonly string[]): boolean {
  const missionSet = new Set(mission);
  return worker.every((item) => missionSet.has(item));
}

function authorityExpanded(mission: CapabilityEnvelope, worker: CapabilityEnvelope): boolean {
  return (
    !isSubset(worker.repositories, mission.repositories) ||
    !isSubset(worker.branches, mission.branches) ||
    !isSubset(worker.externalEffects, mission.externalEffects) ||
    worker.maxRiskClass > mission.maxRiskClass
  );
}

function riskGateReason(
  approvalRule: ApprovalRule,
  request: TransitionRequest,
): string | undefined {
  if (approvalRule !== "risk_dependent") return undefined;
  const riskClass = request.riskClass ?? 0;
  if (riskClass < MIN_APPROVAL_REQUIRED_RISK_CLASS) return undefined;

  const approval = request.approval;
  if (!approval) return "OPERATOR_APPROVAL_REQUIRED";
  if (approval.maxRiskClass < riskClass) return "OPERATOR_APPROVAL_REQUIRED";
  return undefined;
}

function mergeOperationOutcomeGateReason(mergeEvidence: MergeEvidence): string | undefined {
  switch (mergeEvidence.operationOutcome) {
    case undefined:
    case "MERGED":
      return undefined;
    case "INDETERMINATE":
      return "MERGE_OPERATION_INDETERMINATE";
    case "FAILED":
      return "MERGE_OPERATION_FAILED";
    case "REJECTED":
      return "MERGE_OPERATION_REJECTED";
  }
}

function reconciliationGateReason(
  definition: TransitionDefinition,
  request: TransitionRequest,
): string | undefined {
  if (definition.evaluator !== "reconciliation_proof_gate") return undefined;

  const evidence = request.reconciliationEvidence;
  if (!evidence || !evidence.externallyObserved) {
    return "RECONCILIATION_EXTERNAL_OBSERVATION_REQUIRED";
  }
  if (evidence.observedOutcome !== "MERGED") {
    return "RECONCILIATION_OUTCOME_NOT_PROVEN_MERGED";
  }
  return undefined;
}

function omegaGateReasons(
  definition: TransitionDefinition,
  request: TransitionRequest,
): readonly string[] | undefined {
  if (definition.authoritativeCommitter !== ("omega" satisfies AuthoritativeCommitter)) {
    return undefined;
  }
  if (request.committedBy.actorType !== "omega") return ["OMEGA_COMMITTER_REQUIRED"];
  if (!request.omegaCompletionInput) return ["OMEGA_COMPLETION_INPUT_REQUIRED"];

  // Delegate to the real, already-governed completion policy rather than
  // re-deciding completion locally — its failure vocabulary is surfaced
  // verbatim (not collapsed into one generic code) since it is itself the
  // authoritative multi-reason output of an existing deterministic gate.
  const decision = evaluateOmegaCompletion(request.omegaCompletionInput);
  return decision.allowed ? undefined : decision.failures;
}

/**
 * Deterministic admissibility gate order (JARVIS_EVENTS.md "commit-time
 * authority enforcement" / handover "deterministic initial-execution
 * gate"), narrowed to what this pure kernel can decide. First failure wins
 * as the canonical rejection reason — this evaluator never accumulates
 * multiple reason codes for one request.
 */
export function evaluateDevelopmentTransition(request: TransitionRequest): TransitionEvaluation {
  const definition = DEVELOPMENT_TRANSITIONS[request.transitionId] as
    TransitionDefinition | undefined;
  if (!definition) return rejected(request, "UNKNOWN_TRANSITION");

  if (definition.from !== request.from || definition.to !== request.to) {
    return rejected(request, "STATE_MISMATCH");
  }

  if (request.lease) {
    if (Date.parse(request.lease.expiresAt) <= Date.parse(request.now)) {
      return rejected(request, "LEASE_EXPIRED");
    }
    if (request.workerId && request.lease.workerId !== request.workerId) {
      return rejected(request, "LEASE_WORKER_MISMATCH");
    }
  }

  if (request.missionAuthority && request.workerAuthority) {
    if (authorityExpanded(request.missionAuthority, request.workerAuthority)) {
      return rejected(request, "AUTHORITY_EXPANSION");
    }
  }

  const riskReason = riskGateReason(definition.approval, request);
  if (riskReason) return rejected(request, riskReason);

  if (
    request.expectedSubjectVersion !== undefined &&
    request.currentSubjectVersion !== undefined &&
    request.expectedSubjectVersion !== request.currentSubjectVersion
  ) {
    return rejected(request, "STALE_SUBJECT_VERSION");
  }

  if (request.mergeEvidence) {
    const mergeOutcomeReason = mergeOperationOutcomeGateReason(request.mergeEvidence);
    if (mergeOutcomeReason) return rejected(request, mergeOutcomeReason);

    if (request.mergeEvidence.reviewedHeadSha !== request.mergeEvidence.currentHeadSha) {
      return rejected(request, "HEAD_NOT_CURRENT");
    }
  }

  const reconciliationReason = reconciliationGateReason(definition, request);
  if (reconciliationReason) return rejected(request, reconciliationReason);

  const omegaReasons = omegaGateReasons(definition, request);
  if (omegaReasons) return rejected(request, omegaReasons);

  return allowed();
}
