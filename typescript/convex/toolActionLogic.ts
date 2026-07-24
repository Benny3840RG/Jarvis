export const TOOL_ACTION_STATES = ["proposed", "approved", "rejected"] as const;
export const TOOL_ACTION_ACTORS = ["user", "agent", "tool"] as const;
export const TOOL_AUTHORITIES = ["T0", "T1", "T2", "T3"] as const;

export type ToolActionState = (typeof TOOL_ACTION_STATES)[number];
export type ToolActionActor = (typeof TOOL_ACTION_ACTORS)[number];
export type ToolAuthority = (typeof TOOL_AUTHORITIES)[number];

export type ToolActionProposalValues = {
  projectKey: string;
  baseRevision: number;
  tool: string;
  operation: string;
  arguments: Record<string, unknown>;
  rationale: string;
  requiredAuthority: ToolAuthority;
  destructive: boolean;
  idempotencyKey: string;
  proposedBy: ToolActionActor;
};

const MAX_ARGUMENT_DEPTH = 8;
const MAX_ARGUMENT_NODES = 256;
const MAX_ARGUMENT_KEYS = 64;
const MAX_ARGUMENT_KEY_LENGTH = 128;
const MAX_ARGUMENT_STRING_LENGTH = 16_384;
const SENSITIVE_ARGUMENT_KEYS = new Set([
  "authorization",
  "password",
  "passwd",
  "secret",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "servicetoken",
  "clientsecret",
  "privatekey",
  "bearertoken",
  "sessiontoken",
]);

export function cleanRequiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

export function requirePositiveRevision(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function sensitiveKeyFingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function validateArgumentKey(value: string, path: string, label: string): string {
  const cleaned = cleanRequiredText(value, `${label} key at ${path}`);
  if (cleaned.length > MAX_ARGUMENT_KEY_LENGTH) {
    throw new Error(`${label} key at ${path} exceeds ${MAX_ARGUMENT_KEY_LENGTH} characters.`);
  }
  // Non-ASCII characters (Cyrillic "а" vs Latin "a", etc.) must be rejected
  // outright rather than stripped during fingerprinting below — stripping an
  // unrecognised character lets a homoglyph-spoofed key like "аpiKey" collapse
  // to "pikey" and silently evade the credential-key check instead of being
  // caught by it.
  if (!/^[\x20-\x7e]*$/.test(cleaned)) {
    throw new Error(`${label} key ${cleaned} must be ASCII.`);
  }
  if (cleaned.startsWith("$") || cleaned.startsWith("_")) {
    throw new Error(`${label} key ${cleaned} is reserved.`);
  }
  if (SENSITIVE_ARGUMENT_KEYS.has(sensitiveKeyFingerprint(cleaned))) {
    throw new Error(`${label} key ${cleaned} may contain credentials and is not permitted.`);
  }
  return cleaned;
}

function normaliseValue(
  value: unknown,
  path: string,
  depth: number,
  counter: { nodes: number },
  label: string,
): unknown {
  counter.nodes += 1;
  if (counter.nodes > MAX_ARGUMENT_NODES) {
    throw new Error(`${label} tree exceeds ${MAX_ARGUMENT_NODES} values.`);
  }
  if (depth > MAX_ARGUMENT_DEPTH) {
    throw new Error(`${label} tree exceeds maximum depth ${MAX_ARGUMENT_DEPTH}.`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_ARGUMENT_STRING_LENGTH) {
      throw new Error(`${path} exceeds ${MAX_ARGUMENT_STRING_LENGTH} characters.`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normaliseValue(entry, `${path}[${index}]`, depth + 1, counter, label),
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_ARGUMENT_KEYS) {
      throw new Error(`${label} object ${path} exceeds ${MAX_ARGUMENT_KEYS} keys.`);
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of entries.sort(([left], [right]) => left.localeCompare(right))) {
      const cleanedKey = validateArgumentKey(key, path, label);
      output[cleanedKey] = normaliseValue(
        entry,
        `${path}.${cleanedKey}`,
        depth + 1,
        counter,
        label,
      );
    }
    return output;
  }
  throw new Error(`${path} contains an unsupported value.`);
}

export function normaliseToolArguments(value: Record<string, unknown>): Record<string, unknown> {
  return normaliseValue(value, "arguments", 0, { nodes: 0 }, "Tool action argument") as Record<
    string,
    unknown
  >;
}

/**
 * Sanitises an audit-event payload with the same rules as tool-action
 * arguments: rejects reserved, non-ASCII, credential-shaped keys (so a secret
 * can never be written into the audit trail), bounds depth/size, and drops
 * unsupported value types. Distinct from `normaliseToolArguments` only in the
 * label used for error messages.
 */
export function normaliseAuditPayload(value: Record<string, unknown>): Record<string, unknown> {
  return normaliseValue(value, "payload", 0, { nodes: 0 }, "Audit payload") as Record<
    string,
    unknown
  >;
}

export function validateToolAuthority(
  requiredAuthority: ToolAuthority,
  destructive: boolean,
): void {
  if (requiredAuthority === "T0") {
    throw new Error("Tool action proposals require authority T1 or higher.");
  }
  if (destructive && requiredAuthority !== "T3") {
    throw new Error("Destructive tool actions require T3 authority.");
  }
}

export function sameToolActionProposal(
  existing: ToolActionProposalValues,
  proposed: ToolActionProposalValues,
): boolean {
  return (
    existing.projectKey === proposed.projectKey &&
    existing.baseRevision === proposed.baseRevision &&
    existing.tool === proposed.tool &&
    existing.operation === proposed.operation &&
    JSON.stringify(existing.arguments) === JSON.stringify(proposed.arguments) &&
    existing.rationale === proposed.rationale &&
    existing.requiredAuthority === proposed.requiredAuthority &&
    existing.destructive === proposed.destructive &&
    existing.idempotencyKey === proposed.idempotencyKey &&
    existing.proposedBy === proposed.proposedBy
  );
}
