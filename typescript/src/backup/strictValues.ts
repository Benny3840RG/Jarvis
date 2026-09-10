/**
 * Shared strict-validation primitives for archive v4. Unlike the forgiving
 * `normalize*` helpers in the domain stores, nothing here trims, defaults,
 * coerces, or drops: a value is either exactly what a faithfully-stored record
 * holds, or it is rejected. Callers pass a `location` string (e.g.
 * `"clients[3].contacts[0].value"`) so every failure names the offending field.
 */

export class StrictBackupError extends Error {}

export function fail(location: string, detail: string): never {
  throw new StrictBackupError(`${location} ${detail}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) fail(location, "must be an object.");
  return value;
}

export function assertArray(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) fail(location, "must be an array.");
  return value;
}

/**
 * Rejects any property name not in `allowed`. This is what makes the v4 schema
 * *closed*: an unknown field is a hard error, never silently discarded.
 */
export function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) fail(location, `has an unsupported field "${key}".`);
  }
}

/** A finite number, exactly as stored. */
export function strictFiniteNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(location, "must be a finite number.");
  }
  return value;
}

export function strictInteger(value: unknown, location: string): number {
  const n = strictFiniteNumber(value, location);
  if (!Number.isInteger(n)) fail(location, "must be an integer.");
  return n;
}

/** A millisecond-epoch timestamp: finite, non-negative. */
export function strictTimestamp(value: unknown, location: string): number {
  const n = strictFiniteNumber(value, location);
  if (n < 0) fail(location, "must not be negative.");
  return n;
}

export function strictBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") fail(location, "must be a boolean.");
  return value;
}

/**
 * A non-empty string with no leading/trailing whitespace. Every JSON store
 * writes user text through a trim step, so a faithfully-stored value already
 * satisfies this; anything else could not survive a round trip and is rejected
 * here rather than silently changed later.
 */
export function strictText(value: unknown, location: string): string {
  if (typeof value !== "string") fail(location, "must be a string.");
  if (value.length === 0) fail(location, "must not be empty.");
  if (value.trim() !== value) fail(location, "must not have leading or trailing whitespace.");
  return value;
}

export function strictEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(location, `must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/** Reads an optional field: `undefined`/absent stays absent; present is validated. */
export function optional<T>(
  value: unknown,
  location: string,
  read: (value: unknown, location: string) => T,
): T | undefined {
  if (value === undefined) return undefined;
  return read(value, location);
}

export function assertUniqueBy<T>(
  records: readonly T[],
  key: (record: T) => string,
  location: string,
  noun: string,
): void {
  const seen = new Set<string>();
  records.forEach((record, index) => {
    const id = key(record);
    if (seen.has(id)) fail(`${location}[${index}]`, `is a duplicate ${noun} (${id}).`);
    seen.add(id);
  });
}

/** Deep JSON-safety check: only null, finite number, string, boolean, plain array/object. */
export function assertJsonSafe(
  value: unknown,
  location: string,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(location, "contains a non-finite number.");
    return;
  }
  if (typeof value !== "object")
    fail(location, "contains a value that cannot be represented in JSON.");
  if (seen.has(value)) fail(location, "contains a circular reference.");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, `${location}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(location, "contains a non-plain object.");
    }
    for (const [key, entry] of Object.entries(value)) {
      assertJsonSafe(entry, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}
