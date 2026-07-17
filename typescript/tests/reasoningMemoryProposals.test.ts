import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { materializeReasoningMemoryProposal } from "../src/memory/reasoningMemoryProposals.js";

const BASE_INPUT = {
  projectId: "project-1",
  requestId: "request-1",
  proposedAt: "2026-07-16T00:00:00.000Z",
  rationale: "Retain supported project context for explicit approval.",
};

describe("reasoning memory proposals", () => {
  it("materialises deterministic approval-required records", () => {
    const first = materializeReasoningMemoryProposal({
      ...BASE_INPUT,
      drafts: [
        {
          kind: "fact",
          statement: "The supplied bracket thickness is 6 mm.",
          source: "measurement",
          confidence: 1,
        },
        {
          kind: "decision",
          decision: "Add a gusset before service.",
          rationale: "The current load path is insufficiently supported.",
          alternativesRejected: ["Increase weld size only"],
        },
      ],
    });
    const second = materializeReasoningMemoryProposal({
      ...BASE_INPUT,
      drafts: [
        {
          kind: "fact",
          statement: "The supplied bracket thickness is 6 mm.",
          source: "measurement",
          confidence: 1,
        },
        {
          kind: "decision",
          decision: "Add a gusset before service.",
          rationale: "The current load path is insufficiently supported.",
          alternativesRejected: ["Increase weld size only"],
        },
      ],
    });

    assert.deepEqual(first, second);
    assert.equal(first.records.length, 2);
    assert.ok(first.records.every((record) => record.recordId.startsWith("reasoning-")));
    assert.ok(first.updates.every((update) => update.requiresApproval));
    assert.equal(first.records[0]?.kind, "fact");
    if (first.records[0]?.kind === "fact") {
      assert.equal(first.records[0].recordedAt, BASE_INPUT.proposedAt);
    }
    assert.equal(first.records[1]?.kind, "decision");
    if (first.records[1]?.kind === "decision") {
      assert.equal(first.records[1].timestamp, BASE_INPUT.proposedAt);
    }
  });

  it("keeps model assumptions unverified", () => {
    const proposal = materializeReasoningMemoryProposal({
      ...BASE_INPUT,
      drafts: [
        {
          kind: "assumption",
          statement: "The service load may exceed the current design basis.",
          impact: "high",
        },
      ],
    });

    const record = proposal.records[0];
    assert.equal(record?.kind, "assumption");
    if (record?.kind === "assumption") assert.equal(record.status, "unverified");
  });

  it("rejects authoritative inferred facts", () => {
    assert.throws(
      () =>
        materializeReasoningMemoryProposal({
          ...BASE_INPUT,
          drafts: [
            {
              kind: "fact",
              statement: "The assembly is safe.",
              source: "inference",
              confidence: 1,
            },
          ],
        }),
      /inferred fact as authoritative/i,
    );
  });

  it("rejects non-finite and duplicate measurements", () => {
    assert.throws(
      () =>
        materializeReasoningMemoryProposal({
          ...BASE_INPUT,
          drafts: [
            {
              kind: "measurement",
              name: "Thickness",
              value: Number.POSITIVE_INFINITY,
              unit: "mm",
              tolerance: null,
              source: "request input",
            },
          ],
        }),
      /finite/,
    );

    assert.throws(
      () =>
        materializeReasoningMemoryProposal({
          ...BASE_INPUT,
          drafts: [
            {
              kind: "measurement",
              name: "Thickness",
              value: 6,
              unit: "mm",
              tolerance: null,
              source: "request input",
            },
            {
              kind: "measurement",
              name: " thickness ",
              value: 7,
              unit: "MM",
              tolerance: null,
              source: "request input",
            },
          ],
        }),
      /duplicate measurement key/i,
    );
  });

  it("returns an empty proposal without requiring a rationale", () => {
    assert.deepEqual(
      materializeReasoningMemoryProposal({
        ...BASE_INPUT,
        drafts: [],
        rationale: "",
      }),
      { records: [], updates: [], rationale: "" },
    );
  });
});
