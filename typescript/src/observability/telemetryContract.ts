/**
 * Jarvis telemetry correlation + redaction contract (roadmap PR C).
 *
 * The acquisition plan wraps OpenTelemetry in a Jarvis adapter so that (a) every
 * significant event can be joined by a common set of correlation ids, and (b)
 * sensitive categories are never logged by default. This module is that contract:
 * the canonical correlation field set and a key-based redaction policy, both pure
 * and dependency-free. It is deliberately *not yet wired* into the existing
 * emitters (`posthog.ts`, `sentry.ts`) — like the authority contract (PR A), the
 * declaration and its tests land first; a later slice routes emitters through it.
 *
 * This is complementary to, not a replacement for, the existing value-based
 * secret redaction (`http/problemDetails.ts`, `observability/sentry.ts`, …),
 * which masks *known secret strings* out of free text. This contract masks by
 * *attribute key* so a structured event never carries a sensitive value under a
 * sensitive name in the first place.
 */

/**
 * Correlation ids every significant Jarvis event may carry, so one mission's
 * request → decision → agent → model → tool → activity → effect chain can be
 * reconstructed by joining on them. Not every layer sets every field; none is
 * a random id without a family tree.
 */
export const TELEMETRY_CORRELATION_FIELDS = [
  "missionId",
  "workflowId",
  "runId",
  "candidateSha",
  "approvalCycle",
  "effectId",
  "activityId",
  "toolCallId",
  "agentSessionId",
  "workerBuildId",
] as const;

export type TelemetryCorrelationField = (typeof TELEMETRY_CORRELATION_FIELDS)[number];

const CORRELATION_FIELD_SET: ReadonlySet<string> = new Set(TELEMETRY_CORRELATION_FIELDS);

/** The mask substituted for a sensitive value. */
export const REDACTED = "[redacted]" as const;

/**
 * Attribute-key patterns that mark a value as sensitive-to-log by default:
 * credentials/tokens, secrets, passwords, api keys, authorization/bearer,
 * cookies, model prompts, full tool arguments, and email/PII. Matched
 * case-insensitively against the attribute key, never the value.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /passw(?:or)?d/i,
  /credential/i,
  /api[_-]?key/i,
  /authorization/i,
  /bearer/i,
  /cookie/i,
  /prompt/i,
  /arguments/i,
  /(?:^|[._-])args$/i,
  /email/i,
];

/**
 * Whether an attribute key names a value that must not be logged by default.
 * Canonical correlation fields are always safe, even if a future rename made
 * one match a pattern.
 */
export function isSensitiveTelemetryKey(key: string): boolean {
  if (CORRELATION_FIELD_SET.has(key)) return false;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Return a deep copy of `attributes` with every sensitive-keyed value replaced
 * by `REDACTED`. Recurses into nested plain objects and arrays; leaves
 * correlation fields and other values intact. Does not mutate the input, and
 * once a key is redacted its whole subtree is masked (a token object does not
 * leak nested fields).
 */
export function redactTelemetryAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (isSensitiveTelemetryKey(key)) {
      result[key] = REDACTED;
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => redactTelemetryValue(item));
    } else if (isPlainObject(value)) {
      result[key] = redactTelemetryAttributes(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function redactTelemetryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactTelemetryValue(item));
  if (isPlainObject(value)) return redactTelemetryAttributes(value);
  return value;
}

/**
 * Extract only the correlation ids present in an attribute record — the join
 * key for reconstructing one mission's event chain. Values are returned as-is
 * (correlation ids are never sensitive).
 */
export function correlationOf(
  attributes: Readonly<Record<string, unknown>>,
): Partial<Record<TelemetryCorrelationField, unknown>> {
  const correlation: Partial<Record<TelemetryCorrelationField, unknown>> = {};
  for (const field of TELEMETRY_CORRELATION_FIELDS) {
    if (attributes[field] !== undefined) correlation[field] = attributes[field];
  }
  return correlation;
}
