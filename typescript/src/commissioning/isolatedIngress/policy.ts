import { createHash } from "node:crypto";

import type { Capability } from "../../http/contracts.js";
import type { ToolAuthority } from "../../runtime/totalityPolicy.js";
import type { OrchestrationTriggerSource } from "../../orchestration/trigger.js";

/**
 * Fixed policy for the isolated-ingress commissioning probe (issue #324).
 *
 * The composition root — not the request — establishes authority. The ingress
 * never reads an authority claim from the request body; the strict body schema
 * rejects one outright. Authority is bounded to `T1`: enough to admit a durable
 * run and a read-only step, never enough for an external effect.
 */
export const COMMISSIONING_POLICY_VERSION = "commissioning-isolated-ingress:v1" as const;

export const COMMISSIONING_TRIGGER_SOURCE: OrchestrationTriggerSource = "http";
export const COMMISSIONING_TRIGGER_KIND = "isolated-ingress-probe" as const;
export const COMMISSIONING_PROBE_OPERATION_ID = "commissioningProbe" as const;

export const COMMISSIONING_LEASE_TTL_MS = 10_000 as const;
export const COMMISSIONING_MAX_RETRIES = 2 as const;

export function commissioningAuthority(): ToolAuthority {
  return "T1";
}

/**
 * The capability the runner admits to the execution boundary for this probe.
 * Passed only through `OrchestrationRunnerOptions.additionalCapabilities`, so it
 * never reaches `IMPLEMENTED_CAPABILITIES`, the OpenAPI contract or
 * `/api/v1/help`.
 */
export function commissioningProbeCapability(): Capability {
  return {
    operationId: COMMISSIONING_PROBE_OPERATION_ID,
    summary: "Isolated-ingress commissioning probe (read-only, no effect)",
    mutating: false,
    destructive: false,
    mcpExposed: false,
  };
}

/**
 * A canonical fingerprint of the fixed commissioning policy. Bound into every
 * durable run so `beginRun` replay/conflict detection also covers a policy
 * change, and recorded in commissioning evidence.
 */
export function commissioningPolicyFingerprint(): string {
  const canonical = JSON.stringify({
    authority: commissioningAuthority(),
    leaseTtlMs: COMMISSIONING_LEASE_TTL_MS,
    maxRetries: COMMISSIONING_MAX_RETRIES,
    policyVersion: COMMISSIONING_POLICY_VERSION,
    probeOperationId: COMMISSIONING_PROBE_OPERATION_ID,
    triggerKind: COMMISSIONING_TRIGGER_KIND,
    triggerSource: COMMISSIONING_TRIGGER_SOURCE,
  });
  return `commissioning-policy:v1:sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
