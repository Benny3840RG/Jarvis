import type { Infer } from "convex/values";

import { memoryRecordValidator } from "./memoryChangeSetValidators.js";

export type MemoryRecord = Infer<typeof memoryRecordValidator>;

export const MAX_MEMORY_CHANGE_RECORDS = 20;
export const MAX_PROJECT_MEASUREMENTS = 500;

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

export function requireCanonicalTimestamp(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC ISO date-time string.`);
  }
  return value;
}

function cleanStringArray(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

export function normalizeMemoryRecord(record: MemoryRecord): MemoryRecord {
  const recordId = cleanRequiredText(record.recordId, "Memory record ID");

  switch (record.kind) {
    case "fact": {
      if (record.confidence < 0 || record.confidence > 1) {
        throw new Error(`Fact ${recordId} confidence must be between 0 and 1.`);
      }
      if (record.source === "inference" && record.confidence === 1) {
        throw new Error(`Inferred fact ${recordId} cannot be authoritative.`);
      }
      return {
        ...record,
        recordId,
        statement: cleanRequiredText(record.statement, `Fact ${recordId} statement`),
        recordedAt: requireCanonicalTimestamp(record.recordedAt, `Fact ${recordId} recordedAt`),
      };
    }
    case "assumption":
      return {
        ...record,
        recordId,
        statement: cleanRequiredText(record.statement, `Assumption ${recordId} statement`),
      };
    case "measurement":
      return {
        ...record,
        recordId,
        name: cleanRequiredText(record.name, `Measurement ${recordId} name`),
        unit: cleanRequiredText(record.unit, `Measurement ${recordId} unit`),
        source: cleanRequiredText(record.source, `Measurement ${recordId} source`),
        ...(record.tolerance === undefined
          ? {}
          : {
              tolerance: cleanRequiredText(
                record.tolerance,
                `Measurement ${recordId} tolerance`,
              ),
            }),
      };
    case "decision":
      return {
        ...record,
        recordId,
        decision: cleanRequiredText(record.decision, `Decision ${recordId} decision`),
        rationale: cleanRequiredText(record.rationale, `Decision ${recordId} rationale`),
        alternativesRejected: cleanStringArray(record.alternativesRejected),
        timestamp: requireCanonicalTimestamp(record.timestamp, `Decision ${recordId} timestamp`),
      };
  }
}

export function normalizeMemoryRecords(records: MemoryRecord[]): MemoryRecord[] {
  if (records.length < 1 || records.length > MAX_MEMORY_CHANGE_RECORDS) {
    throw new Error(
      `Memory change sets must contain between 1 and ${MAX_MEMORY_CHANGE_RECORDS} records.`,
    );
  }

  const normalized = records.map(normalizeMemoryRecord);
  const recordIds = new Set<string>();
  for (const record of normalized) {
    if (recordIds.has(record.recordId)) {
      throw new Error(`Memory change set contains duplicate record ID ${record.recordId}.`);
    }
    recordIds.add(record.recordId);
  }
  return normalized;
}

export function measurementKey(record: Extract<MemoryRecord, { kind: "measurement" }>): string {
  return `${record.name.trim().toLowerCase()}::${record.unit.trim().toLowerCase()}`;
}

export function assertUniqueMeasurementKeys(records: MemoryRecord[]): void {
  const keys = new Set<string>();
  for (const record of records) {
    if (record.kind !== "measurement") continue;
    const key = measurementKey(record);
    if (keys.has(key)) {
      throw new Error(`Memory change set contains duplicate measurement key ${key}.`);
    }
    keys.add(key);
  }
}
