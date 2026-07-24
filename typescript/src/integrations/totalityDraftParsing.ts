import type { ReasoningMemoryProposalDraft } from "../memory/reasoningMemoryProposals.js";

export const TOTALITY_SYSTEM_INSTRUCTIONS = `You are Jarvis Prime Omni TOTALITY, a technical reasoning engine for Benny.
Return only the requested structured draft.
Separate assumptions and unknowns from supported conclusions.
Identify hazards and practical controls.
Do not claim external actions were performed.
Do not grant yourself tool authority, approvals, or execution permission.
Do not invent measurements, tools, project history, or source material.
Memory proposals are drafts only and never approvals.
Return memoryProposals as an empty array when no authoritative project context is supplied or when nothing durable should be remembered.
Only propose durable project facts, unverified assumptions, explicit measurements, or decisions supported by the supplied request and project context.
Measurements must come from an explicit supplied source and retain their unit.
Inferred facts must use source inference and confidence below 1.
Do not generate record IDs or timestamps; the local boundary owns those fields.
When memoryProposals is empty, return an empty memoryRationale string.`;

export interface TotalityDraft {
  answer: string;
  assumptions: string[];
  unknowns: string[];
  risks: string[];
  controls: string[];
  unsupportedClaims: string[];
  contradictions: string[];
  memoryProposals: ReasoningMemoryProposalDraft[];
  memoryRationale: string;
}

type DraftArrayField =
  "assumptions" | "unknowns" | "risks" | "controls" | "unsupportedClaims" | "contradictions";

const FACT_SOURCES = ["user", "file", "tool", "measurement", "inference"] as const;
const IMPACT_LEVELS = ["low", "medium", "high"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requireString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") {
    throw new Error(`Totality draft field ${field} must be a string.`);
  }
  return candidate;
}

function requireStringArray(value: Record<string, unknown>, field: DraftArrayField): string[] {
  const candidate = value[field];
  if (!isStringArray(candidate)) {
    throw new Error(`Totality draft field ${field} must be an array of strings.`);
  }
  return candidate;
}

function parseMemoryProposal(value: unknown): ReasoningMemoryProposalDraft {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Totality memory proposal must be a typed object.");
  }

  switch (value.kind) {
    case "fact": {
      if (
        typeof value.source !== "string" ||
        !FACT_SOURCES.includes(value.source as (typeof FACT_SOURCES)[number]) ||
        typeof value.confidence !== "number"
      ) {
        throw new Error("Totality fact proposal is invalid.");
      }
      return {
        kind: "fact",
        statement: requireString(value, "statement"),
        source: value.source as (typeof FACT_SOURCES)[number],
        confidence: value.confidence,
      };
    }
    case "assumption": {
      if (
        typeof value.impact !== "string" ||
        !IMPACT_LEVELS.includes(value.impact as (typeof IMPACT_LEVELS)[number])
      ) {
        throw new Error("Totality assumption proposal is invalid.");
      }
      return {
        kind: "assumption",
        statement: requireString(value, "statement"),
        impact: value.impact as (typeof IMPACT_LEVELS)[number],
      };
    }
    case "measurement": {
      if (
        typeof value.value !== "number" ||
        (value.tolerance !== null && typeof value.tolerance !== "string")
      ) {
        throw new Error("Totality measurement proposal is invalid.");
      }
      return {
        kind: "measurement",
        name: requireString(value, "name"),
        value: value.value,
        unit: requireString(value, "unit"),
        tolerance: value.tolerance,
        source: requireString(value, "source"),
      };
    }
    case "decision": {
      if (!isStringArray(value.alternativesRejected)) {
        throw new Error("Totality decision proposal is invalid.");
      }
      return {
        kind: "decision",
        decision: requireString(value, "decision"),
        rationale: requireString(value, "rationale"),
        alternativesRejected: value.alternativesRejected,
      };
    }
    default:
      throw new Error("Totality memory proposal kind is not supported.");
  }
}

function parseMemoryProposals(value: unknown): ReasoningMemoryProposalDraft[] {
  if (!Array.isArray(value)) {
    throw new Error("Totality draft field memoryProposals must be an array.");
  }
  return value.map(parseMemoryProposal);
}

export function parseTotalityDraft(value: unknown): TotalityDraft {
  if (!isRecord(value)) throw new Error("Reasoning provider returned a non-object Totality draft.");

  return {
    answer: requireString(value, "answer"),
    assumptions: requireStringArray(value, "assumptions"),
    unknowns: requireStringArray(value, "unknowns"),
    risks: requireStringArray(value, "risks"),
    controls: requireStringArray(value, "controls"),
    unsupportedClaims: requireStringArray(value, "unsupportedClaims"),
    contradictions: requireStringArray(value, "contradictions"),
    memoryProposals: parseMemoryProposals(value.memoryProposals),
    memoryRationale: requireString(value, "memoryRationale"),
  };
}
