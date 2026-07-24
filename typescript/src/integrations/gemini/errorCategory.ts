import { GeminiRequestError } from "./totalityReasoner.js";

export type GeminiErrorCategory = "quota_exhausted" | "rate_limited" | "dependency_failed";

const QUOTA_EXHAUSTION_PATTERN =
  /\b(?:resource_exhausted|resource has been exhausted|quota exceeded|quota|billing)\b/i;

export function categorizeGeminiRequestError(error: GeminiRequestError): GeminiErrorCategory {
  if (error.status === 429) {
    return QUOTA_EXHAUSTION_PATTERN.test(error.message) ? "quota_exhausted" : "rate_limited";
  }
  return "dependency_failed";
}
