import { createHash } from "node:crypto";

import type { OrchestrationGraph } from "./graph.js";

function canonicalize(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Orchestration fingerprint numbers must be finite.");
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
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
