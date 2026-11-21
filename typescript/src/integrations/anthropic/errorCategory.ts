import { AnthropicRequestError } from "./totalityReasoner.js";

export type AnthropicErrorCategory =
  | "quota_exhausted"
  | "rate_limited"
  | "authentication_failed"
  | "request_rejected"
  | "dependency_failed";

/** Anthropic reports an empty prepaid balance as a 400 naming the credit balance. */
const QUOTA_EXHAUSTION_PATTERN = /\bcredit balance\b|\bbilling\b/i;

export function categorizeAnthropicRequestError(
  error: AnthropicRequestError,
): AnthropicErrorCategory {
  if (error.status === 429) return "rate_limited";
  if (error.status === 401 || error.status === 403) return "authentication_failed";
  if (error.status === 400 || error.status === 404 || error.status === 413) {
    return QUOTA_EXHAUSTION_PATTERN.test(error.message) ? "quota_exhausted" : "request_rejected";
  }
  return "dependency_failed";
}
