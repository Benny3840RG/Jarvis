const OBJECT_TAG = "[object Object]";

function isPlainObject(value: object): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== OBJECT_TAG) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }

  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError(`Canonical JSON rejects values of type ${typeof value}.`);
  }

  if (typeof value !== "object")
    throw new TypeError("Canonical JSON received an unsupported value.");
  if (seen.has(value)) throw new TypeError("Canonical JSON rejects cyclic values.");

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => normalize(entry, seen));
    if (!isPlainObject(value))
      throw new TypeError("Canonical JSON accepts only arrays and plain objects.");

    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalize(value[key], seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

/**
 * Produces a deterministic JSON representation suitable for security-sensitive
 * fingerprints. Object keys are recursively sorted and non-JSON/ambiguous
 * values fail closed instead of being silently omitted or coerced.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set<object>()));
}
