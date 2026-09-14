export const MAX_AUTOMATIC_RETRIES = 2;

const KNOWN_OUTCOMES = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "unavailable",
]);

function safeOutcome(value) {
  return KNOWN_OUTCOMES.has(value) ? value : "unavailable";
}

export function classifyAutobuildRecovery({ receipt, priorRetries = 0 } = {}) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !receipt.stages ||
    typeof receipt.stages !== "object"
  ) {
    return { action: "block", reason: "invalid-diagnostic-receipt" };
  }
  if (!Number.isSafeInteger(priorRetries) || priorRetries < 0) {
    return { action: "block", reason: "invalid-retry-count" };
  }

  const buildResult = safeOutcome(receipt.build_result);
  const stages = {
    dependencies: safeOutcome(receipt.stages.dependencies),
    worker: safeOutcome(receipt.stages.worker),
    guard: safeOutcome(receipt.stages.guard),
    publication: safeOutcome(receipt.stages.publication),
  };

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
