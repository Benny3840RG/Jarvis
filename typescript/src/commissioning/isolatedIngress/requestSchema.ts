const MAX_NONCE_LENGTH = 200;
const MAX_PAYLOAD_KEYS = 16;
const MAX_PAYLOAD_KEY_LENGTH = 64;
const MAX_PAYLOAD_VALUE_LENGTH = 512;

const ALLOWED_TOP_KEYS = ["nonce", "payload"] as const;

export type CommissioningIngressBody = {
  nonce: string;
  payload: Record<string, string | number | boolean>;
};

export class CommissioningRequestError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(detail: string): never {
  throw new CommissioningRequestError(detail);
}

/**
 * Strict schema for the isolated-ingress probe body. Deliberately closed: an
 * unknown top-level field — `authority` above all — is rejected, so a caller
 * can never smuggle an authority claim into the run. Authority is established
 * only by the composition-root policy (`commissioningAuthority()`).
 *
 * The returned object is the canonical semantic input: `orchestrationRequestFingerprint`
 * hashes it after `canonicalize`, so a whitespace or key-order change replays
 * and any value change conflicts.
 */
export function parseCommissioningIngressBody(body: unknown): CommissioningIngressBody {
  if (!isRecord(body)) fail("The commissioning ingress body must be a JSON object.");
  for (const key of Object.keys(body)) {
    if (!(ALLOWED_TOP_KEYS as readonly string[]).includes(key)) {
      fail(`The commissioning ingress body has an unsupported field "${key}".`);
    }
  }
  if (typeof body.nonce !== "string" || body.nonce.length === 0) {
    fail("The commissioning ingress body requires a non-empty string nonce.");
  }
  if (body.nonce.length > MAX_NONCE_LENGTH) {
    fail(`The commissioning ingress nonce must be at most ${MAX_NONCE_LENGTH} characters.`);
  }

  const payload: Record<string, string | number | boolean> = Object.create(null);
  if (body.payload !== undefined) {
    if (!isRecord(body.payload)) fail("The commissioning ingress payload must be a JSON object.");
    const keys = Object.keys(body.payload);
    if (keys.length > MAX_PAYLOAD_KEYS) {
      fail(`The commissioning ingress payload must have at most ${MAX_PAYLOAD_KEYS} fields.`);
    }
    for (const key of keys) {
      if (key.length === 0 || key.length > MAX_PAYLOAD_KEY_LENGTH) {
        fail(`The commissioning ingress payload field name "${key}" is out of range.`);
      }
      const value = body.payload[key];
      if (typeof value === "string") {
        if (value.length > MAX_PAYLOAD_VALUE_LENGTH) {
          fail(`The commissioning ingress payload field "${key}" is too long.`);
        }
        payload[key] = value;
      } else if (typeof value === "boolean") {
        payload[key] = value;
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          fail(`The commissioning ingress payload field "${key}" must be a finite number.`);
        }
        payload[key] = value;
      } else {
        fail(
          `The commissioning ingress payload field "${key}" must be a string, number or boolean.`,
        );
      }
    }
  }

  return { nonce: body.nonce, payload };
}
