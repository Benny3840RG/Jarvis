import type { PermissionEnvelope, RoutingDecision } from "./totalityPolicy.js";

export type ValidationStatus = "pass" | "warning" | "fail";

export interface ValidationCheck {
  id: string;
  status: ValidationStatus;
  message?: string;
}

export interface ValidationReport {
  passed: boolean;
  checks: ValidationCheck[];
  warnings: string[];
  blockingFailures: string[];
}

export interface ValidationInput {
  routing: RoutingDecision;
  assumptions?: string[];
  unsupportedClaims?: string[];
  contradictions?: string[];
  hazards?: string[];
  controls?: string[];
  requestedAuthority?: Pick<PermissionEnvelope, "toolAuthority" | "actionState">;
}

const TOOL_AUTHORITY_RANK: Record<PermissionEnvelope["toolAuthority"], number> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

const ACTION_STATE_RANK: Record<PermissionEnvelope["actionState"], number> = {
  read: 0,
  propose: 1,
  approve: 2,
  execute: 3,
};

export function validateTotalityResult(input: ValidationInput): ValidationReport {
  const checks: ValidationCheck[] = [];
  const warnings: string[] = [];
  const blockingFailures: string[] = [];

  const assumptionsPresent = (input.assumptions?.length ?? 0) > 0;
  checks.push({
    id: "ASSUMPTIONS_SURFACED",
    status: assumptionsPresent ? "pass" : "warning",
    message: assumptionsPresent ? undefined : "No assumptions were recorded; confirm the task is fully specified.",
  });
  if (!assumptionsPresent) warnings.push("No assumptions were recorded.");

  const unsupportedClaims = input.unsupportedClaims ?? [];
  checks.push({
    id: "UNSUPPORTED_FACTUAL_CLAIMS",
    status: unsupportedClaims.length === 0 ? "pass" : "fail",
    message: unsupportedClaims.length === 0 ? undefined : unsupportedClaims.join("; "),
  });
  blockingFailures.push(...unsupportedClaims.map((claim) => `Unsupported claim: ${claim}`));

  const contradictions = input.contradictions ?? [];
  checks.push({
    id: "TECHNICAL_CONTRADICTIONS",
    status: contradictions.length === 0 ? "pass" : "fail",
    message: contradictions.length === 0 ? undefined : contradictions.join("; "),
  });
  blockingFailures.push(...contradictions.map((item) => `Contradiction: ${item}`));

  const highRisk = ["high", "critical"].includes(input.routing.permission.riskLevel);
  const controlsPresent = (input.controls?.length ?? 0) > 0;
  checks.push({
    id: "HIGH_RISK_CONTROLS_PRESENT",
    status: !highRisk || controlsPresent ? "pass" : "fail",
    message: !highRisk || controlsPresent ? undefined : "High-risk work requires explicit controls.",
  });
  if (highRisk && !controlsPresent) blockingFailures.push("High-risk work has no explicit controls.");

  const requested = input.requestedAuthority;
  const authorityWithinBoundary =
    !requested ||
    (TOOL_AUTHORITY_RANK[requested.toolAuthority] <=
      TOOL_AUTHORITY_RANK[input.routing.permission.toolAuthority] &&
      ACTION_STATE_RANK[requested.actionState] <= ACTION_STATE_RANK[input.routing.permission.actionState]);
  checks.push({
    id: "TOOL_AUTHORITY_BOUNDARY",
    status: authorityWithinBoundary ? "pass" : "fail",
    message: authorityWithinBoundary ? undefined : "Requested action exceeds the routing permission envelope.",
  });
  if (!authorityWithinBoundary) blockingFailures.push("Requested action exceeds authority.");

  const hazards = input.hazards ?? [];
  if (highRisk && hazards.length === 0) {
    warnings.push("High-risk route has no recorded hazards.");
    checks.push({
      id: "HAZARDS_IDENTIFIED",
      status: "warning",
      message: "High-risk route has no recorded hazards.",
    });
  } else {
    checks.push({ id: "HAZARDS_IDENTIFIED", status: "pass" });
  }

  return {
    passed: blockingFailures.length === 0,
    checks,
    warnings,
    blockingFailures,
  };
}
