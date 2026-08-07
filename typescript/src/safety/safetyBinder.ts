import type { ActionState, RiskLevel, ToolAuthority } from "../runtime/totalityPolicy.js";

export const IMMUTABLE_SAFETY_CATEGORIES = [
  "domain",
  "cross-domain",
  "memory",
  "reliability",
  "proposal",
  "tool-action",
] as const;

export const SAFETY_BINDING_VERSION = "jarvis-safety-binding:v1" as const;

export type SafetyCategory = (typeof IMMUTABLE_SAFETY_CATEGORIES)[number];
export type SafetyStatus = "pass" | "blocked";
export type SafetyPhase =
  | "reasoning"
  | "memory-proposal"
  | "memory-apply"
  | "tool-stage"
  | "tool-approve"
  | "tool-revoke"
  | "tool-execute"
  | "tool-reconcile";

export type SafetyBindingInput = {
  phase: SafetyPhase;
  riskLevel: RiskLevel;
  hazards?: readonly string[];
  controls?: readonly string[];
  domainBound?: boolean;
  crossDomain?: boolean;
  crossDomainConsistent?: boolean;
  memoryRequired?: boolean;
  memorySafe?: boolean;
  reliabilityRequired?: boolean;
  reliabilityHealthy?: boolean;
  proposalSafe?: boolean;
  toolAllowlisted?: boolean;
  requiredAuthority?: ToolAuthority;
  grantedAuthority?: ToolAuthority;
  actionState?: ActionState;
  requiresApproval?: boolean;
  approvalPresent?: boolean;
  destructive?: boolean;
  externalEffect?: boolean;
  idempotencyKey?: string;
  correlationId?: string;
  payload?: unknown;
  stateValid?: boolean;
  outcome?: "pending" | "partial" | "succeeded" | "failed" | "indeterminate";
  recoveryAvailable?: boolean;
};

export type SafetyCategoryDecision = Readonly<{
  category: SafetyCategory;
  status: SafetyStatus;
  reasons: readonly string[];
}>;

export type SafetyBinding = Readonly<{
  version: typeof SAFETY_BINDING_VERSION;
  phase: SafetyPhase;
  status: SafetyStatus;
  categories: readonly SafetyCategoryDecision[];
}>;

const AUTHORITY_LEVEL: Record<ToolAuthority, number> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

const MUTATING_PHASES = new Set<SafetyPhase>([
  "memory-apply",
  "tool-stage",
  "tool-approve",
  "tool-revoke",
  "tool-execute",
  "tool-reconcile",
]);

const TOOL_PHASES = new Set<SafetyPhase>([
  "tool-stage",
  "tool-approve",
  "tool-revoke",
  "tool-execute",
  "tool-reconcile",
]);

const PROPOSAL_PHASES = new Set<SafetyPhase>([
  "reasoning",
  "memory-proposal",
  "tool-stage",
  "tool-approve",
]);

const CREDENTIAL_FIELD =
  /(access.?token|refresh.?token|api.?key|secret|password|private.?key|authorization|bearer)/i;

function hasCredentialLikeField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCredentialLikeField);
  if (typeof value !== "object" || value === null) return false;

  return Object.entries(value).some(([key, child]) => {
    return CREDENTIAL_FIELD.test(key) || hasCredentialLikeField(child);
  });
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function decision(
  category: SafetyCategory,
  reasons: readonly string[] = [],
): SafetyCategoryDecision {
  return {
    category,
    status: reasons.length === 0 ? "pass" : "blocked",
    reasons: [...reasons],
  };
}

function domainDecision(input: SafetyBindingInput): SafetyCategoryDecision {
  const reasons: string[] = [];
  if (input.domainBound === false) {
    reasons.push("The action is not bound to an authorised domain.");
  }
  if (input.riskLevel === "high" || input.riskLevel === "critical") {
    if ((input.hazards?.length ?? 0) === 0) {
      reasons.push("High or critical risk requires at least one identified hazard.");
    }
    if ((input.controls?.length ?? 0) === 0) {
      reasons.push("High or critical risk requires at least one explicit control.");
    }
  }
  return decision("domain", reasons);
}

function crossDomainDecision(input: SafetyBindingInput): SafetyCategoryDecision {
  if (!input.crossDomain) return decision("cross-domain");
  return decision(
    "cross-domain",
    input.crossDomainConsistent === true
      ? []
      : ["Cross-domain state is not consistent for this transition."],
  );
}

function memoryDecision(input: SafetyBindingInput): SafetyCategoryDecision {
  const required =
    input.memoryRequired || input.phase === "memory-proposal" || input.phase === "memory-apply";
  if (!required && input.memorySafe !== false) return decision("memory");
  return decision(
    "memory",
    input.memorySafe === true ? [] : ["Memory transition lacks validated authoritative evidence."],
  );
}

function reliabilityDecision(input: SafetyBindingInput): SafetyCategoryDecision {
  const required =
    input.reliabilityRequired ||
    input.externalEffect ||
    input.phase === "tool-reconcile" ||
    MUTATING_PHASES.has(input.phase);
  const reasons: string[] = [];

  if (required && input.reliabilityHealthy !== true) {
    reasons.push("This transition lacks current reliability evidence.");
  }
  if (MUTATING_PHASES.has(input.phase) && !input.idempotencyKey?.trim()) {
    reasons.push("Mutating transitions require an idempotency key.");
  }
  if (MUTATING_PHASES.has(input.phase) && !input.correlationId?.trim()) {
    reasons.push("Mutating transitions require a correlation identifier.");
  }
  if (input.externalEffect && !input.recoveryAvailable) {
    reasons.push("External effects require a durable recovery or reconciliation path.");
  }
  if (input.outcome === "indeterminate" && !input.recoveryAvailable) {
    reasons.push("Indeterminate outcomes require a recovery or reconciliation path.");
  }
  return decision("reliability", reasons);
}

function proposalDecision(input: SafetyBindingInput): SafetyCategoryDecision {
  if (!PROPOSAL_PHASES.has(input.phase)) return decision("proposal");
  return decision(
    "proposal",
    input.proposalSafe === true ? [] : ["The proposal has not passed its validation boundary."],
  );
}

function toolActionDecision(input: SafetyBindingInput): SafetyCategoryDecision {
  if (!TOOL_PHASES.has(input.phase)) return decision("tool-action");

  const reasons: string[] = [];
  if (input.toolAllowlisted !== true) {
    reasons.push("The tool action is not present in the reviewed allowlist.");
  }
  if (input.stateValid === false) {
    reasons.push("The tool action state is not valid for this transition.");
  }
  if (hasCredentialLikeField(input.payload)) {
    reasons.push("Credential-like fields must not cross the governed action boundary.");
  }
  if (
    input.requiredAuthority !== undefined &&
    input.grantedAuthority !== undefined &&
    AUTHORITY_LEVEL[input.grantedAuthority] < AUTHORITY_LEVEL[input.requiredAuthority]
  ) {
    reasons.push("Granted authority is below the action requirement.");
  }
  if (input.requiresApproval && !input.approvalPresent) {
    reasons.push("This transition requires an explicit approval.");
  }
  if ((input.destructive || input.externalEffect) && input.actionState === "execute") {
    if (!input.approvalPresent)
      reasons.push("External or destructive execution requires approval.");
  }
  return decision("tool-action", reasons);
}

export function bindSafety(input: SafetyBindingInput): SafetyBinding {
  const decisions: Record<SafetyCategory, SafetyCategoryDecision> = {
    domain: domainDecision(input),
    "cross-domain": crossDomainDecision(input),
    memory: memoryDecision(input),
    reliability: reliabilityDecision(input),
    proposal: proposalDecision(input),
    "tool-action": toolActionDecision(input),
  };
  const categories = IMMUTABLE_SAFETY_CATEGORIES.map((category) => decisions[category]);
  return freeze({
    version: SAFETY_BINDING_VERSION,
    phase: input.phase,
    status: categories.some((category) => category.status === "blocked") ? "blocked" : "pass",
    categories,
  });
}
