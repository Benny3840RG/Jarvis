import type { ExternalReconciliationRecord } from "../reconciliation/externalReconciliation.js";

const STATES = new Set<ExternalReconciliationRecord["state"]>([
  "observing",
  "pending",
  "claimed",
  "resolved",
  "escalated",
]);

export function parseReconciliationState(
  value: unknown,
): ExternalReconciliationRecord["state"] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !STATES.has(value as ExternalReconciliationRecord["state"])) {
    throw new Error("Unsupported reconciliation state.");
  }
  return value as ExternalReconciliationRecord["state"];
}

export function parseReconciliationLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error("Invalid reconciliation limit.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100) {
    throw new Error("Invalid reconciliation limit.");
  }
  return limit;
}
