import type { RuntimeReconciliationHealth } from "../reconciliation/runtimeReconciliationHost.js";

export type ReliabilityHealthAssessment =
  | { healthy: true }
  | {
      healthy: false;
      reason:
        | "reconciliation-not-running"
        | "reconciliation-no-successful-cycle"
        | "reconciliation-cycle-failed"
        | "reconciliation-cycle-stale";
    };

export function assessReconciliationHealth(
  health: RuntimeReconciliationHealth,
  now = Date.now(),
): ReliabilityHealthAssessment {
  if (!health.enabled) return { healthy: true };
  if (health.state !== "running") {
    return { healthy: false, reason: "reconciliation-not-running" };
  }
  if (
    health.lastCycleOutcome === "failed" ||
    health.lastCycleOutcome === "degraded" ||
    (health.lastCycleFailureCount !== undefined && health.lastCycleFailureCount > 0)
  ) {
    return { healthy: false, reason: "reconciliation-cycle-failed" };
  }
  if (
    health.lastCycleOutcome !== "success" ||
    health.lastSuccessfulCycleAt === undefined ||
    health.lastCycleFailureCount !== 0
  ) {
    return { healthy: false, reason: "reconciliation-no-successful-cycle" };
  }
  const successfulAt = Date.parse(health.lastSuccessfulCycleAt);
  if (
    !Number.isFinite(successfulAt) ||
    health.freshnessMs === undefined ||
    now - successfulAt > health.freshnessMs
  ) {
    return { healthy: false, reason: "reconciliation-cycle-stale" };
  }
  return { healthy: true };
}
