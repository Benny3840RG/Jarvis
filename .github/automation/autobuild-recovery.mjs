export const MAX_AUTOMATIC_RETRIES = 2;

const KNOWN_OUTCOMES = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "unavailable",
]);

const STAGE_NAMES = ["dependencies", "worker", "guard", "publication"];
const EXECUTED_OUTCOMES = new Set(["success", "failure", "cancelled"]);

export function classifyAutobuildRecovery({ receipt, priorRetries = 0 } = {}) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    !receipt.stages ||
    typeof receipt.stages !== "object" ||
    Array.isArray(receipt.stages)
  ) {
    return { action: "block", reason: "invalid-diagnostic-receipt" };
  }
  if (!Number.isSafeInteger(priorRetries) || priorRetries < 0) {
    return { action: "block", reason: "invalid-retry-count" };
  }

  const buildResult = receipt.build_result;
  const verificationResult = receipt.verification_result;
  const stages = receipt.stages;
  const outcomes = STAGE_NAMES.map((stage) => stages[stage]);
  // The workflow explicitly emits "unavailable" when runner outputs are lost.
  // Missing or unknown receipt fields must never acquire that retry authority.
  if (
    !KNOWN_OUTCOMES.has(buildResult) ||
    !KNOWN_OUTCOMES.has(verificationResult) ||
    outcomes.some((outcome) => !KNOWN_OUTCOMES.has(outcome))
  ) {
    return { action: "block", reason: "invalid-diagnostic-receipt" };
  }
  // These stages run in order with the default success() condition. A later
  // executed stage cannot corroborate a failed, skipped, or unknown predecessor.
  if (
    outcomes.some(
      (outcome, index) =>
        EXECUTED_OUTCOMES.has(outcome) &&
        outcomes.slice(0, index).some((previous) => previous !== "success"),
    ) ||
    (buildResult === "success" &&
      outcomes.some((outcome) =>
        ["failure", "cancelled", "skipped"].includes(outcome),
      )) ||
    (EXECUTED_OUTCOMES.has(verificationResult) &&
      (buildResult !== "success" || stages.publication !== "success"))
  ) {
    return { action: "block", reason: "invalid-diagnostic-receipt" };
  }

  if (stages.publication === "success") {
    return { action: "ignore", reason: "candidate-published" };
  }
  if (stages.guard === "failure") {
    return { action: "block", reason: "policy-guard-failure" };
  }

  const retryable =
    ["failure", "cancelled"].includes(buildResult) &&
    (["failure", "cancelled", "unavailable"].includes(stages.dependencies) ||
      ["failure", "cancelled", "unavailable"].includes(stages.worker));

  if (!retryable) {
    return { action: "block", reason: "non-retryable-build-failure" };
  }
  if (priorRetries >= MAX_AUTOMATIC_RETRIES) {
    return { action: "block", reason: "retry-budget-exhausted" };
  }
  return { action: "retry", reason: "transient-pre-publication-failure" };
}
