import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeMemoryRecord,
  sameMemoryProposal,
  type MemoryRecord,
} from "../convex/memoryChangeSetLogic.js";

function fact(confidence = 0.9): Extract<MemoryRecord, { kind: "fact" }> {
  return {
    kind: "fact",
    recordId: "fact-1",
    statement: "Bracket thickness is verified.",
    source: "measurement",
    confidence,
    recordedAt: "2026-07-15T00:00:00.000Z",
  };
}

describe("memory change set logic", () => {
  it("treats a new request ID as the same substantive proposal", () => {
    const existing = {
      requestId: "request-1",
      projectKey: "project-1",
      baseRevision: 3,
      records: [fact()],
      rationale: "Record a verified measurement.",
      proposedBy: "user" as const,
    };
    const retry = {
      requestId: "request-2",
      projectKey: "project-1",
      baseRevision: 3,
      records: [fact()],
      rationale: "Record a verified measurement.",
      proposedBy: "user" as const,
    };

    assert.equal(sameMemoryProposal(existing, retry), true);
  });

  it("rejects non-finite fact confidence", () => {
    assert.throws(() => normalizeMemoryRecord(fact(Number.NaN)), /confidence must be finite/);
  });

  it("rejects non-finite measurement values", () => {
    assert.throws(
      () =>
        normalizeMemoryRecord({
          kind: "measurement",
          recordId: "measurement-1",
          name: "Bracket thickness",
          value: Number.POSITIVE_INFINITY,
          unit: "mm",
          source: "caliper",
        }),
      /value must be finite/,
    );
  });

  it("bounds rejected decision alternatives", () => {
    assert.throws(
      () =>
        normalizeMemoryRecord({
          kind: "decision",
          recordId: "decision-1",
          decision: "Use the gusseted bracket.",
          rationale: "It has the clearest load path.",
          alternativesRejected: Array.from({ length: 51 }, (_, index) => `Alternative ${index}`),
          timestamp: "2026-07-15T00:00:00.000Z",
        }),
      /cannot contain more than 50 rejected alternatives/,
    );
  });
});
