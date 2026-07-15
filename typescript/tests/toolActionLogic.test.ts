import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normaliseToolArguments,
  sameToolActionProposal,
  validateToolAuthority,
  type ToolActionProposalValues,
} from "../convex/toolActionLogic.js";

function proposal(overrides: Partial<ToolActionProposalValues> = {}): ToolActionProposalValues {
  return {
    projectKey: "project-1",
    baseRevision: 4,
    tool: "calendar",
    operation: "create_event",
    arguments: { title: "Inspect bracket", durationMinutes: 30 },
    rationale: "Schedule the approved inspection.",
    requiredAuthority: "T2",
    destructive: false,
    idempotencyKey: "request-1:create-event",
    proposedBy: "agent",
    ...overrides,
  };
}

describe("tool action proposal validation", () => {
  it("normalises argument objects deterministically", () => {
    assert.deepEqual(
      normaliseToolArguments({
        z: true,
        nested: { b: 2, a: 1 },
        a: "first",
      }),
      {
        a: "first",
        nested: { a: 1, b: 2 },
        z: true,
      },
    );
  });

  it("rejects non-finite values and reserved keys", () => {
    assert.throws(
      () => normaliseToolArguments({ value: Number.POSITIVE_INFINITY }),
      /finite number/,
    );
    assert.throws(() => normaliseToolArguments({ _secret: "no" }), /reserved/);
    assert.throws(() => normaliseToolArguments({ $operator: "no" }), /reserved/);
  });

  it("rejects excessive nesting", () => {
    let value: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 9; index += 1) value = { next: value };
    assert.throws(() => normaliseToolArguments(value), /maximum depth/);
  });

  it("requires proposal authority and reserves T3 for destructive actions", () => {
    assert.throws(() => validateToolAuthority("T0", false), /T1 or higher/);
    assert.throws(() => validateToolAuthority("T2", true), /require T3/);
    assert.doesNotThrow(() => validateToolAuthority("T3", true));
    assert.doesNotThrow(() => validateToolAuthority("T1", false));
  });

  it("compares normalised proposals without considering persistence metadata", () => {
    const first = proposal();
    assert.equal(sameToolActionProposal(first, proposal()), true);
    assert.equal(
      sameToolActionProposal(first, proposal({ arguments: { durationMinutes: 60 } })),
      false,
    );
    assert.equal(sameToolActionProposal(first, proposal({ destructive: true })), false);
  });
});
