import { OpenAIRequestError } from "./totalityReasoner.js";

export type OpenAIErrorCategory =
  | "quota_exhausted"
  | "rate_limited"
  | "authentication_failed"
  | "request_rejected"
  | "dependency_failed";

const QUOTA_EXHAUSTION_PATTERN =
  /\b(?:insufficient[_ -]?quota|quota|billing|usage limit|credits? exhausted)\b/i;

export function categorizeOpenAIRequestError(error: OpenAIRequestError): OpenAIErrorCategory {
  if (error.status === 429) {
    return QUOTA_EXHAUSTION_PATTERN.test(error.message) ? "quota_exhausted" : "rate_limited";
  }
  if (error.status === 401) return "authentication_failed";
  if (error.status !== null && error.status >= 400 && error.status < 500) {
    return "request_rejected";
  }
  return "dependency_failed";
}
