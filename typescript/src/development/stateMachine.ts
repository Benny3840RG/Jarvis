/**
 * Development transition kernel (JARVIS Phase 1, Task 3).
 *
 * Pure, deterministic admissibility evaluation for the Development domain
 * transition grammar defined in TRANSITIONS.yaml and explained in
 * JARVIS_TRANSITIONS.md. This module
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

import { canonicalJson } from "../actions/canonicalJson.js";
import { sha256Hex } from "../actions/sha256.js";
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

/**
 * Field names deliberately mirror the real lease shape already in use on
 * `orchestrationSteps` (`convex/orchestrationState.ts`: `leaseOwner`,
 * `leaseToken`, `leaseExpiresAt`) for vocabulary consistency across
 * domains, even though Development leases are a distinct subject.
 * `fencingToken` is a genuine extension: the real orchestration lease
 * reissues a random UUID per lease with no monotonic ordering, so it
 * cannot yet tell an old lease-holder it has been superseded. This kernel
 * adds that as a strictly-increasing counter the caller must supply
 * alongside `currentFencingToken` (the subject's latest known token,
 * analogous to `currentSubjectVersion`).
 */
export type LeaseInfo = {
  readonly leaseToken: string;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: string;
  readonly fencingToken: number;
};

/**
 * Binds an approval to an exact subject, transition, effect, authority
 * envelope, and policy subject version. `transitionCommitted` is the
 * consumption fact for the bound transition. It is not mission `COMPLETE`,
 * which remains the ΩΣ-only development state.
 */
export type ApprovalRef = {
  readonly approvalId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly maxRiskClass: number;
  readonly subjectId: string;
  readonly transitionId: DevelopmentTransitionId;
  /** Opaque hash of the proposal content; recorded for audit, not independently re-verified by this kernel (it has no visibility into proposal/diff content). */
  readonly proposalHash: string;
  readonly approvedSha?: string;
  readonly effectHash: string;
  readonly authorityEnvelopeHash: string;
  readonly effectiveRisk: number;
  readonly policyDecisionFingerprint: string;
  /** Snapshot of the policy aggregate's subjectVersion at approval time. */
  readonly policySubjectVersion: number;
  /** True once the bound transition has been durably recorded as executed. */
  readonly transitionCommitted: boolean;
};

/**
 * Human-readable policy version. Ordering reuses the policy aggregate's
 * `subjectVersion`; there is no separate sequenceNumber.
 */
export type PolicyVersion = {
  readonly version: string;
  readonly validFrom: string;
  readonly validUntil?: string;
  readonly retroactiveInvalidation?: RetroactiveInvalidation;
};

/** One governed policy aggregate version. `subjectVersion` is the only order. */
export type PolicyHistoryEntry = PolicyVersion & {
  readonly subjectVersion: number;
};

/**
 * Scoped invalidation. `scope` defaults to PENDING_ONLY, which skips
 * approvals whose bound transition has already committed.
 */
export type RetroactiveInvalidation = {
  readonly transitionIds: readonly string[];
  readonly affectedApprovals: "ALL" | { readonly approvalIds: readonly string[] };
  readonly scope?: "PENDING_ONLY" | "ALL";
  readonly reason: string;
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
   * through INDETERMINATE). Omitted/`"MERGED"` proceeds to the
   * ordinary head-integrity check below.
   */
  readonly operationOutcome?: MergeOperationOutcome;
  /** Explicit unrecoverable-failure signal (e.g. a rejected/closed PR). Defaults to retryable when omitted. */
  readonly retryable?: boolean;
};

/**
 * Authoritative external observation gathered during reconciliation
 * (JARVIS_EVENTS.md "INDETERMINATE resolution contract"). Elapsed time is
 * never itself an observation — `externallyObserved` must be true and
 * `observedOutcome` must actually establish `"MERGED"` before
 * INDETERMINATE -> MERGED is admissible.
 */
export type ReconciliationEvidence = {
  readonly externallyObserved: boolean;
  readonly observedOutcome: "MERGED" | "NOT_MERGED" | "STILL_UNKNOWN";
  readonly observationSource: string;
};

// Verification/review evidence for `deterministic_verification_success_gate`,
// `deterministic_review_findings_gate` and `deterministic_review_readiness_gate`
// now has a real trusted-derivation boundary: convex/developmentState.ts's
// commit() looks up a durable, head-bound record (convex/developmentEvidence.ts)
// before calling evaluateDevelopmentTransition, the same way it already does
// for mergeEvidence via trustedMergeReason. The kernel no longer accepts an
// inline evidence claim for these gates -- commit() rejects via its
// precondition layer before evaluateDevelopmentTransition is even called.

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
  readonly subjectId?: string;
  readonly lease?: LeaseInfo;
  readonly missionAuthority?: CapabilityEnvelope;
  readonly workerAuthority?: CapabilityEnvelope;
  readonly branch?: string;
  readonly repository?: string;
  readonly riskClass?: number;
  /** A model's own risk assessment. May only raise effective risk, never lower the deterministic floor. */
  readonly modelSuggestedRisk?: number;
  /** Risk derived from evidence (e.g. diff size, blast radius). Same one-directional rule as modelSuggestedRisk. */
  readonly evidenceDerivedRisk?: number;
  readonly approval?: ApprovalRef;
  /** The concrete effect currently being proposed/executed, hashed and compared against approval.effectHash when supplied. */
  readonly effectPayload?: Readonly<Record<string, unknown>>;
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
  /**
   * Policy aggregate history and its current subjectVersion. Supply both or
   * neither. A partial pair fails closed rather than skipping invalidation.
   */
  readonly policyHistory?: readonly PolicyHistoryEntry[];
  readonly currentPolicySubjectVersion?: number;
  /** The subject's latest known fencing token, analogous to currentSubjectVersion. */
  readonly currentFencingToken?: number;
};

export type RejectionDescriptor = {
  readonly transitionId: DevelopmentTransitionId;
  readonly sourceState: DevelopmentState;
  readonly requestedBy: ActorRef;
  readonly reasonCodes: readonly string[];
};

/**
 * handover "Failure semantics": FAILED derives a retry disposition rather
 * than being treated as automatically retriable. Only ever set alongside
 * `MERGE_OPERATION_FAILED` — REJECTED/INDETERMINATE outcomes, and ALLOWED
 * evaluations, never carry one.
 */
export type RetryDisposition = "RESUME_SAME_OPERATION" | "NEW_EXECUTION_REQUIRED" | "NO_RETRY";

export type TransitionEvaluation = {
  readonly allowed: boolean;
  readonly outcome: "ALLOWED" | "REJECTED";
  readonly reasons: readonly string[];
  readonly rejection?: RejectionDescriptor;
  readonly retryDisposition?: RetryDisposition;
};

const MIN_APPROVAL_REQUIRED_RISK_CLASS = 2;

function allowed(): TransitionEvaluation {
  return Object.freeze({ allowed: true, outcome: "ALLOWED", reasons: Object.freeze([]) });
}

function rejected(
  request: TransitionRequest,
  reasonCodes: string | readonly string[],
  retryDisposition?: RetryDisposition,
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
    ...(retryDisposition ? { retryDisposition } : {}),
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

const EFFECT_HASH_VERSION = "development-effect-hash:v1";
const AUTHORITY_ENVELOPE_HASH_VERSION = "development-authority-envelope-hash:v1";
const POLICY_FINGERPRINT_VERSION = "development-policy-fingerprint:v1";

// Reuses the repository's existing canonical-JSON encoder (already shared by
// toolExecution.ts/quoteSendTool.ts) rather than inventing another one, per
// the handover's "one canonical encoder" rule.
function digest(prefix: string, value: unknown): string {
  return `${prefix}:${sha256Hex(canonicalJson(value))}`;
}

export function computeEffectHash(input: {
  readonly transitionId: DevelopmentTransitionId;
  readonly subjectId: string;
  readonly from: DevelopmentState;
  readonly to: DevelopmentState;
  readonly effectPayload: Readonly<Record<string, unknown>>;
}): string {
  return digest(EFFECT_HASH_VERSION, input);
}

export function computeAuthorityEnvelopeHash(envelope: CapabilityEnvelope): string {
  return digest(AUTHORITY_ENVELOPE_HASH_VERSION, envelope);
}

const ALL_SCOPE_INVALIDATION_RISK_CLASS = 3;

/**
 * Phase 1 gate for `affectedApprovals: "ALL"`. Rate limits, dual confirmation,
 * and blast-radius counts are not implemented; risk class 3 and an audit trail
 * are required before that write is admissible.
 */
export function evaluateAllScopeInvalidation(input: {
  readonly invalidation: RetroactiveInvalidation;
  readonly authorityRiskClass: number;
  readonly auditTrailRecorded: boolean;
}): { readonly admissible: boolean; readonly reasons: readonly string[] } {
  if (input.invalidation.affectedApprovals !== "ALL") {
    return { admissible: true, reasons: Object.freeze([]) };
  }
  const reasons: string[] = [];
  if (
    !Number.isSafeInteger(input.authorityRiskClass) ||
    input.authorityRiskClass < ALL_SCOPE_INVALIDATION_RISK_CLASS
  ) {
    reasons.push("ALL_SCOPE_RISK_3_REQUIRED");
  }
  if (!input.auditTrailRecorded || input.invalidation.reason.trim().length === 0) {
    reasons.push("ALL_SCOPE_AUDIT_TRAIL_REQUIRED");
  }
  return { admissible: reasons.length === 0, reasons: Object.freeze(reasons) };
}

/** Policy subjectVersion order. Versions at or before the approval snapshot are not retroactive. */
export function isRetroactivelyInvalidated(
  approval: Pick<ApprovalRef, "approvalId" | "policySubjectVersion" | "transitionCommitted">,
  transitionId: string,
  policyHistory: readonly PolicyHistoryEntry[],
  currentSubjectVersion: number,
): boolean {
  const relevantVersions = policyHistory.filter(
    (entry) =>
      entry.subjectVersion > approval.policySubjectVersion &&
      entry.subjectVersion <= currentSubjectVersion,
  );
  for (const policy of relevantVersions) {
    const invalidation = policy.retroactiveInvalidation;
    if (!invalidation) continue;
    if (!invalidation.transitionIds.includes(transitionId)) continue;
    const scope = invalidation.scope ?? "PENDING_ONLY";
    const targeted =
      invalidation.affectedApprovals === "ALL" ||
      invalidation.affectedApprovals.approvalIds.includes(approval.approvalId);
    if (!targeted) continue;
    if (scope === "PENDING_ONLY" && approval.transitionCommitted) continue;
    return true;
  }
  return false;
}

/** Records that the bound transition committed. Does not set mission COMPLETE. */
export function markApprovalTransitionCommitted<T extends ApprovalRef>(approval: T): T {
  if (approval.transitionCommitted) return approval;
  return { ...approval, transitionCommitted: true };
}

export function committedApprovalEventFields(approval: ApprovalRef): {
  readonly approvalId: string;
  readonly approvalTransitionCommitted: true;
  readonly policySubjectVersion: number;
} {
  const consumed = markApprovalTransitionCommitted(approval);
  return {
    approvalId: consumed.approvalId,
    approvalTransitionCommitted: true,
    policySubjectVersion: consumed.policySubjectVersion,
  };
}

/**
 * Fingerprints only the decision-relevant fields of a transition
 * definition, so an unrelated registry change doesn't invalidate an
 * existing approval (handover "Policy fingerprint": "Unrelated policy
 * changes should not necessarily invalidate the approval").
 */
export function computePolicyDecisionFingerprint(definition: TransitionDefinition): string {
  return digest(POLICY_FINGERPRINT_VERSION, {
    id: definition.id,
    approval: definition.approval,
    sideEffectClass: definition.sideEffectClass,
    authoritativeCommitter: definition.authoritativeCommitter,
    invariants: definition.invariants,
  });
}

const RISK_FLOOR_BY_SIDE_EFFECT_CLASS: Record<TransitionDefinition["sideEffectClass"], number> = {
  S0: 0,
  S1: 0,
  S2: 1,
  S3: 1,
  S4: 2,
  S5: 3,
};

/**
 * effectiveRisk = max(deterministic floor, riskClass, modelSuggestedRisk,
 * evidenceDerivedRisk) — a caller/model may raise risk, never lower the
 * floor below what the transition's own side-effect class demands.
 */
function computeEffectiveRisk(
  definition: TransitionDefinition,
  request: TransitionRequest,
): number {
  const floor = RISK_FLOOR_BY_SIDE_EFFECT_CLASS[definition.sideEffectClass];
  return Math.max(
    floor,
    request.riskClass ?? 0,
    request.modelSuggestedRisk ?? 0,
    request.evidenceDerivedRisk ?? 0,
  );
}

function approvalGateReason(
  definition: TransitionDefinition,
  request: TransitionRequest,
): string | undefined {
  if (definition.approval !== ("risk_dependent" satisfies ApprovalRule)) return undefined;

  const effectiveRisk = computeEffectiveRisk(definition, request);
  if (effectiveRisk < MIN_APPROVAL_REQUIRED_RISK_CLASS) return undefined;

  const approval = request.approval;
  if (!approval) return "OPERATOR_APPROVAL_REQUIRED";
  if (approval.maxRiskClass < effectiveRisk) return "OPERATOR_APPROVAL_REQUIRED";
  if (approval.transitionId !== request.transitionId) return "APPROVAL_TRANSITION_MISMATCH";
  if (request.subjectId !== undefined && approval.subjectId !== request.subjectId) {
    return "APPROVAL_SUBJECT_MISMATCH";
  }
  if (request.effectPayload !== undefined) {
    const liveEffectHash = computeEffectHash({
      transitionId: request.transitionId,
      subjectId: request.subjectId ?? approval.subjectId,
      from: request.from,
      to: request.to,
      effectPayload: request.effectPayload,
    });
    if (approval.effectHash !== liveEffectHash) return "APPROVAL_EFFECT_MISMATCH";
  }
  if (request.workerAuthority !== undefined) {
    const liveAuthorityHash = computeAuthorityEnvelopeHash(request.workerAuthority);
    if (approval.authorityEnvelopeHash !== liveAuthorityHash) {
      return "APPROVAL_AUTHORITY_ENVELOPE_MISMATCH";
    }
  }
  if (approval.policyDecisionFingerprint !== computePolicyDecisionFingerprint(definition)) {
    return "APPROVAL_STALE_POLICY_CONTEXT";
  }
  if (!Number.isSafeInteger(approval.policySubjectVersion) || approval.policySubjectVersion < 0) {
    return "APPROVAL_POLICY_SUBJECT_VERSION_INVALID";
  }
  const historySupplied = request.policyHistory !== undefined;
  const currentSupplied = request.currentPolicySubjectVersion !== undefined;
  if (historySupplied !== currentSupplied) return "POLICY_HISTORY_INCOMPLETE";
  if (
    request.policyHistory !== undefined &&
    request.currentPolicySubjectVersion !== undefined &&
    isRetroactivelyInvalidated(
      approval,
      request.transitionId,
      request.policyHistory,
      request.currentPolicySubjectVersion,
    )
  ) {
    return "APPROVAL_RETROACTIVELY_INVALIDATED";
  }
  if (approval.transitionCommitted) return "APPROVAL_TRANSITION_ALREADY_COMMITTED";
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

/**
 * handover "Retry/resume": retry re-attempts the same operation only when
 * its effect hasn't changed underneath it; a changed effect needs a new
 * proposal/execution, never a blind resume.
 *
 * Deliberately compares against `approval.approvedSha` rather than
 * recomputing the generic effect hash: a mismatched effect hash is already
 * its own earlier, harder failure (`APPROVAL_EFFECT_MISMATCH`) that rejects
 * before this gate is ever reached, so duplicating that check here would be
 * dead code. `approvedSha` is a distinct, narrower signal — specifically
 * "did the reviewed head move" — that can differ independently.
 */
function deriveFailedMergeRetryDisposition(
  mergeEvidence: MergeEvidence,
  request: TransitionRequest,
): RetryDisposition {
  if (mergeEvidence.retryable === false) return "NO_RETRY";

  if (
    request.approval?.approvedSha !== undefined &&
    mergeEvidence.reviewedHeadSha !== request.approval.approvedSha
  ) {
    return "NEW_EXECUTION_REQUIRED";
  }

  return "RESUME_SAME_OPERATION";
}

// verificationGateReason/reviewGateReason were removed: commit()'s
// precondition layer in convex/developmentState.ts now gates
// deterministic_verification_success_gate, deterministic_review_findings_gate
// and deterministic_review_readiness_gate against a trusted, head-bound
// evidence record before this kernel is ever called for those transitions.

function reconciliationGateReason(
  definition: TransitionDefinition,
  request: TransitionRequest,
): string | undefined {
  if (definition.evaluator !== "deterministic_reconciliation_success_gate") return undefined;

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

  if (!definition.sources.includes(request.from) || definition.target !== request.to) {
    return rejected(request, "STATE_MISMATCH");
  }

  if (request.lease) {
    if (Date.parse(request.lease.leaseExpiresAt) <= Date.parse(request.now)) {
      return rejected(request, "LEASE_EXPIRED");
    }
    if (request.workerId && request.lease.leaseOwner !== request.workerId) {
      return rejected(request, "LEASE_WORKER_MISMATCH");
    }
    if (
      request.currentFencingToken !== undefined &&
      request.lease.fencingToken < request.currentFencingToken
    ) {
      // A superseding lease has already been issued for this subject; an
      // old fencing token must lose authority even if it hasn't expired.
      return rejected(request, "STALE_FENCING_TOKEN");
    }
  }

  if (request.missionAuthority && request.workerAuthority) {
    if (authorityExpanded(request.missionAuthority, request.workerAuthority)) {
      return rejected(request, "AUTHORITY_EXPANSION");
    }
  }

  const approvalReason = approvalGateReason(definition, request);
  if (approvalReason) return rejected(request, approvalReason);

  if (
    request.expectedSubjectVersion !== undefined &&
    request.currentSubjectVersion !== undefined &&
    request.expectedSubjectVersion !== request.currentSubjectVersion
  ) {
    return rejected(request, "STALE_SUBJECT_VERSION");
  }

  if (request.mergeEvidence) {
    const mergeOutcomeReason = mergeOperationOutcomeGateReason(request.mergeEvidence);
    if (mergeOutcomeReason) {
      const retryDisposition =
        mergeOutcomeReason === "MERGE_OPERATION_FAILED"
          ? deriveFailedMergeRetryDisposition(request.mergeEvidence, request)
          : undefined;
      return rejected(request, mergeOutcomeReason, retryDisposition);
    }

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
