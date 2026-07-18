import { OpenAIRequestError } from "./totalityReasoner.js";

export type OpenAIErrorCategory = "quota_exhausted" | "rate_limited" | "dependency_failed";

const QUOTA_EXHAUSTION_PATTERN =
  /\b(?:insufficient[_ -]?quota|quota|billing|usage limit|credits? exhausted)\b/i;

export function categorizeOpenAIRequestError(error: OpenAIRequestError): OpenAIErrorCategory {
  if (error.status === 429) {
    return QUOTA_EXHAUSTION_PATTERN.test(error.message) ? "quota_exhausted" : "rate_limited";
  }
  return "dependency_failed";
}
