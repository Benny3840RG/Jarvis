import { createHash } from "node:crypto";

import type { MemoryRecord } from "./memoryChangeSets.js";
import type { MemoryUpdateProposal } from "../runtime/totalityContracts.js";

const MAX_REASONING_MEMORY_RECORDS = 20;
const MAX_DECISION_ALTERNATIVES = 50;

export type ReasoningMemoryFactDraft = {
  kind: "fact";
  statement: string;
  source: "user" | "file" | "tool" | "measurement" | "inference";
  confidence: number;
};

export type ReasoningMemoryAssumptionDraft = {
  kind: "assumption";
  statement: string;
  impact: "low" | "medium" | "high";
};

export type ReasoningMemoryMeasurementDraft = {
  kind: "measurement";
  name: string;
  value: number;
  unit: string;
  tolerance: string | null;
  source: string;
};

export type ReasoningMemoryDecisionDraft = {
  kind: "decision";
  decision: string;
  rationale: string;
  alternativesRejected: string[];
};

export type ReasoningMemoryProposalDraft =
  | ReasoningMemoryFactDraft
  | ReasoningMemoryAssumptionDraft
  | ReasoningMemoryMeasurementDraft
  | ReasoningMemoryDecisionDraft;

export type MaterializedReasoningMemoryProposal = {
  records: MemoryRecord[];
  updates: MemoryUpdateProposal[];
  rationale: string;
};

function cleanRequiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

function canonicalTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error("Reasoning memory proposal timestamp must be canonical UTC ISO date-time.");
  }
  return value;
}

function recordIdFor(
  projectId: string,
  requestId: string,
  index: number,
  draft: ReasoningMemoryProposalDraft,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ projectId, requestId, index, draft }))
    .digest("hex")
    .slice(0, 20);
  return `reasoning-${draft.kind}-${digest}`;
}

function cleanAlternatives(values: string[]): string[] {
  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (cleaned.length > MAX_DECISION_ALTERNATIVES) {
    throw new Error(
      `Reasoning decisions cannot contain more than ${MAX_DECISION_ALTERNATIVES} rejected alternatives.`,
    );
  }
  return cleaned;
}

function materializeRecord(
  projectId: string,
  requestId: string,
  proposedAt: string,
  index: number,
  draft: ReasoningMemoryProposalDraft,
): MemoryRecord {
  const recordId = recordIdFor(projectId, requestId, index, draft);

  switch (draft.kind) {
    case "fact": {
      if (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
        throw new Error("Reasoning fact confidence must be finite and between 0 and 1.");
      }
      if (draft.source === "inference" && draft.confidence === 1) {
        throw new Error("Reasoning cannot propose an inferred fact as authoritative.");
      }
      return {
        kind: "fact",
        recordId,
        statement: cleanRequiredText(draft.statement, "Reasoning fact statement"),
        source: draft.source,
        confidence: draft.confidence,
        recordedAt: proposedAt,
      };
    }
    case "assumption":
      return {
        kind: "assumption",
        recordId,
        statement: cleanRequiredText(draft.statement, "Reasoning assumption statement"),
        status: "unverified",
        impact: draft.impact,
      };
    case "measurement": {
      if (!Number.isFinite(draft.value)) {
        throw new Error("Reasoning measurement value must be finite.");
      }
      const tolerance = draft.tolerance?.trim();
      return {
        kind: "measurement",
        recordId,
        name: cleanRequiredText(draft.name, "Reasoning measurement name"),
        value: draft.value,
        unit: cleanRequiredText(draft.unit, "Reasoning measurement unit"),
        ...(tolerance ? { tolerance } : {}),
        source: cleanRequiredText(draft.source, "Reasoning measurement source"),
      };
    }
    case "decision":
      return {
        kind: "decision",
        recordId,
        decision: cleanRequiredText(draft.decision, "Reasoning decision"),
        rationale: cleanRequiredText(draft.rationale, "Reasoning decision rationale"),
        alternativesRejected: cleanAlternatives(draft.alternativesRejected),
        timestamp: proposedAt,
      };
  }
}

function updateFor(record: MemoryRecord): MemoryUpdateProposal {
  const target =
    record.kind === "fact"
      ? "facts"
      : record.kind === "assumption"
        ? "assumptions"
        : record.kind === "measurement"
          ? "measurements"
          : "decisions";

  return {
    operation: "append",
    target,
    value: record,
    classification: record.kind,
    requiresApproval: true,
  };
}

function assertUniqueMeasurements(records: MemoryRecord[]): void {
  const keys = new Set<string>();
  for (const record of records) {
    if (record.kind !== "measurement") continue;
    const key = `${record.name.trim().toLowerCase()}::${record.unit.trim().toLowerCase()}`;
    if (keys.has(key)) {
      throw new Error(`Reasoning memory proposal contains duplicate measurement key ${key}.`);
    }
    keys.add(key);
  }
}

export function materializeReasoningMemoryProposal(input: {
  projectId: string;
  requestId: string;
  proposedAt: string;
  drafts: ReasoningMemoryProposalDraft[];
  rationale: string;
}): MaterializedReasoningMemoryProposal {
  if (input.drafts.length === 0) {
    return { records: [], updates: [], rationale: "" };
  }
  if (input.drafts.length > MAX_REASONING_MEMORY_RECORDS) {
    throw new Error(
      `Reasoning cannot propose more than ${MAX_REASONING_MEMORY_RECORDS} memory records.`,
    );
  }

  const proposedAt = canonicalTimestamp(input.proposedAt);
  const records = input.drafts.map((draft, index) =>
    materializeRecord(input.projectId, input.requestId, proposedAt, index, draft),
  );
  assertUniqueMeasurements(records);

  return {
    records,
    updates: records.map(updateFor),
    rationale: cleanRequiredText(input.rationale, "Reasoning memory proposal rationale"),
  };
}
