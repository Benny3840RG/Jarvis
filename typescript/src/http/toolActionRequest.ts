import type { ToolActionActor, ToolActionState } from "../actions/toolActions.js";
import type { ToolAuthority } from "../runtime/totalityPolicy.js";

const ACTION_STATES: readonly ToolActionState[] = [
  "proposed",
  "approved",
  "rejected",
  "expired",
  "revoked",
];
const ACTION_ACTORS: readonly ToolActionActor[] = ["user", "agent", "tool"];
const TOOL_AUTHORITIES: readonly ToolAuthority[] = ["T0", "T1", "T2", "T3"];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function sensitiveKeyFingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeArgumentKey(value: string, path: string): string {
  const cleaned = requiredString(value, `Argument key at ${path}`);
  if (cleaned.length > MAX_ARGUMENT_KEY_LENGTH) {
    throw new Error(
      `Argument key at ${path} must not exceed ${MAX_ARGUMENT_KEY_LENGTH} characters.`,
    );
  }
  // Non-ASCII characters (Cyrillic "а" vs Latin "a", etc.) must be rejected
  // outright rather than stripped during fingerprinting below — stripping an
  // unrecognised character lets a homoglyph-spoofed key like "аpiKey" collapse
  // to "pikey" and silently evade the credential-key check instead of being
  // caught by it.
  if (!/^[\x20-\x7e]*$/.test(cleaned)) {
    throw new Error(`Argument key ${cleaned} must be ASCII.`);
  }
  if (cleaned.startsWith("$") || cleaned.startsWith("_")) {
    throw new Error(`Argument key ${cleaned} is reserved.`);
  }
  if (SENSITIVE_ARGUMENT_KEYS.has(sensitiveKeyFingerprint(cleaned))) {
    throw new Error(`Argument key ${cleaned} may contain credentials and is not permitted.`);
  }
  return cleaned;
}

function safeArgumentValue(
  value: unknown,
  path: string,
  depth: number,
  counter: { nodes: number },
): unknown {
  counter.nodes += 1;
  if (counter.nodes > MAX_ARGUMENT_NODES) {
    throw new Error(`arguments must not exceed ${MAX_ARGUMENT_NODES} values.`);
  }
  if (depth > MAX_ARGUMENT_DEPTH) {
    throw new Error(`arguments must not exceed depth ${MAX_ARGUMENT_DEPTH}.`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_ARGUMENT_STRING_LENGTH) {
      throw new Error(`${path} must not exceed ${MAX_ARGUMENT_STRING_LENGTH} characters.`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      safeArgumentValue(entry, `${path}[${index}]`, depth + 1, counter),
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_ARGUMENT_KEYS) {
      throw new Error(`${path} must not exceed ${MAX_ARGUMENT_KEYS} keys.`);
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of entries.sort(([left], [right]) => left.localeCompare(right))) {
      const cleanedKey = safeArgumentKey(key, path);
      output[cleanedKey] = safeArgumentValue(entry, `${path}.${cleanedKey}`, depth + 1, counter);
    }
    return output;
  }
  throw new Error(`${path} contains an unsupported value.`);
}

function argumentsRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("arguments must be a JSON object.");
  return safeArgumentValue(value, "arguments", 0, { nodes: 0 }) as Record<string, unknown>;
}

function toolAuthority(value: unknown): ToolAuthority {
  const authority = requiredString(value, "requiredAuthority");
  if (!TOOL_AUTHORITIES.includes(authority as ToolAuthority)) {
    throw new Error("requiredAuthority is not supported.");
  }
  return authority as ToolAuthority;
}

function actionActor(value: unknown): ToolActionActor {
  const actor = requiredString(value, "proposedBy");
  if (!ACTION_ACTORS.includes(actor as ToolActionActor)) {
    throw new Error("proposedBy is not supported.");
  }
  return actor as ToolActionActor;
}

export function parseStageToolAction(body: unknown): {
  actionId: string;
  expectedRevision: number;
  tool: string;
  operation: string;
  arguments: Record<string, unknown>;
  rationale: string;
  requiredAuthority: ToolAuthority;
  destructive: boolean;
  idempotencyKey: string;
  proposedBy: ToolActionActor;
} {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  const requiredAuthority = toolAuthority(body.requiredAuthority);
  const destructive = booleanValue(body.destructive, "destructive");
  if (requiredAuthority === "T0") {
    throw new Error("Tool action proposals require authority T1 or higher.");
  }
  if (destructive && requiredAuthority !== "T3") {
    throw new Error("Destructive tool actions require T3 authority.");
  }

  return {
    actionId: requiredString(body.actionId, "actionId"),
    expectedRevision: positiveInteger(body.expectedRevision, "expectedRevision"),
    tool: requiredString(body.tool, "tool"),
    operation: requiredString(body.operation, "operation"),
    arguments: argumentsRecord(body.arguments),
    rationale: requiredString(body.rationale, "rationale"),
    requiredAuthority,
    destructive,
    idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey"),
    proposedBy: actionActor(body.proposedBy),
  };
}

export function parseToolActionExpectedRevision(body: unknown): number {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  return positiveInteger(body.expectedRevision, "expectedRevision");
}

export function parseToolActionApproval(body: unknown): {
  expectedRevision: number;
  approvalToken: string;
} {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  return {
    expectedRevision: positiveInteger(body.expectedRevision, "expectedRevision"),
    approvalToken: requiredString(body.approvalToken, "approvalToken"),
  };
}

export function parseToolActionRejectionReason(body: unknown): string {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  return requiredString(body.reason, "reason");
}

export function parseToolActionRevocation(body: unknown): {
  reason: string;
  approvalToken: string;
} {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  return {
    reason: requiredString(body.reason, "reason"),
    approvalToken: requiredString(body.approvalToken, "approvalToken"),
  };
}

export function parseToolActionState(value: unknown): ToolActionState | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ACTION_STATES.includes(value as ToolActionState)) {
    throw new Error("state is not supported.");
  }
  return value as ToolActionState;
}

export function parseToolActionListLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("limit must be an integer between 1 and 100.");
  }
  return parsed;
}

export function parseExecuteToolAction(body: unknown): {
  idempotencyKey: string;
  dryRun?: boolean;
  timeoutMs?: number;
} {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey");
  const dryRun = body.dryRun === undefined ? undefined : booleanValue(body.dryRun, "dryRun");
  const timeoutMs =
    body.timeoutMs === undefined ? undefined : positiveInteger(body.timeoutMs, "timeoutMs");
  return {
    idempotencyKey,
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}
