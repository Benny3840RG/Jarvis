import { createHash } from "node:crypto";

import type { OrchestrationGraph } from "./graph.js";

function canonicalize(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Orchestration fingerprint numbers must be finite.");
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) result[key] = canonicalize(entry);
  }
  return result;
}

export function orchestrationPlanFingerprint(graph: OrchestrationGraph): string {
  const plan = graph.orderedNodes().map((node) => ({
    id: node.id,
    command: node.command,
    dependsOn: [...(node.dependsOn ?? [])].sort(),
    weight: node.weight ?? 0,
  }));
  const canonicalJson = JSON.stringify(canonicalize(plan));
  return `orchestration-plan:v1:sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;
}

/**
 * A stable fingerprint of a *validated, already-canonical* trigger request. Two
 * requests that differ only in JSON key order or insignificant whitespace hash
 * identically (via `canonicalize` + `JSON.stringify`); any change to a
 * semantically significant value changes the hash. Callers pass the parsed,
 * schema-validated request body — never the raw bytes — so a whitespace or
 * key-order change is already gone by the time it reaches here, and the
 * synthetic pre-image (`JSON.stringify(canonicalize(input))`) is safe to retain
 * as commissioning evidence.
 */
export function orchestrationRequestFingerprint(input: unknown): {
  fingerprint: string;
  preImage: string;
} {
  const preImage = JSON.stringify(canonicalize(input));
  return {
    fingerprint: `orchestration-request:v1:sha256:${createHash("sha256")
      .update(preImage)
      .digest("hex")}`,
    preImage,
  };
}
