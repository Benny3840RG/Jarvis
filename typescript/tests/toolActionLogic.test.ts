import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampApprovalTtlMs,
  deriveConsumptionPolicy,
  deriveDefaultApprovalTtlMs,
  isApprovalExpired,
  normaliseAuditPayload,
  normaliseToolArguments,
  requirePageSize,
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

  it("rejects credential-shaped argument keys at any depth", () => {
    assert.throws(() => normaliseToolArguments({ api_key: "secret" }), /credentials/);
    assert.throws(
      () => normaliseToolArguments({ auth: { Authorization: "Bearer secret" } }),
      /credentials/,
    );
    assert.throws(() => normaliseToolArguments({ clientSecret: "secret" }), /credentials/);
  });

  it("rejects non-ASCII argument keys instead of silently stripping confusable characters", () => {
    // "аpiKey" below uses a Cyrillic "а" (U+0430), not Latin "a". Stripping
    // unrecognised characters during fingerprinting (rather than rejecting
    // them) would collapse this to "pikey", which doesn't match "apikey" —
    // silently letting a credential-shaped key past the filter under a name
    // that looks identical to a human reviewer.
    assert.throws(() => normaliseToolArguments({ аpiKey: "secret" }), /must be ASCII/);
    assert.throws(() => normaliseToolArguments({ ɑpiKey: "secret" }), /must be ASCII/);
  });

  it("rejects oversized string values", () => {
    assert.throws(() => normaliseToolArguments({ body: "x".repeat(16_385) }), /16384 characters/);
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

describe("page size bounds shared by tasks, reminders, and notes listPage queries", () => {
  it("accepts integers from 1 to 100 and returns them unchanged", () => {
    assert.equal(requirePageSize(1, "Task"), 1);
    assert.equal(requirePageSize(50, "Reminder"), 50);
    assert.equal(requirePageSize(100, "Note"), 100);
  });

  it("rejects out-of-range, non-integer, and non-finite values with a domain-labelled message", () => {
    for (const value of [
      0,
      101,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      assert.throws(
        () => requirePageSize(value, "Task"),
        /Task page size must be an integer from 1 to 100\./,
      );
    }
  });

  it("labels the error with the caller's domain name", () => {
    assert.throws(() => requirePageSize(0, "Reminder"), /Reminder page size/);
    assert.throws(() => requirePageSize(0, "Note"), /Note page size/);
  });
});

describe("audit payload sanitisation", () => {
  it("normalises a clean payload deterministically", () => {
    assert.deepEqual(normaliseAuditPayload({ actionId: "a-1", nested: { b: 2, a: 1 }, count: 3 }), {
      actionId: "a-1",
      count: 3,
      nested: { a: 1, b: 2 },
    });
  });

  it("rejects credential-shaped keys so a secret cannot enter the audit trail", () => {
    assert.throws(() => normaliseAuditPayload({ apiKey: "secret" }), /credentials/);
    assert.throws(
      () => normaliseAuditPayload({ meta: { Authorization: "Bearer secret" } }),
      /credentials/,
    );
    assert.throws(() => normaliseAuditPayload({ serviceToken: "secret" }), /credentials/);
  });

  it("rejects reserved and non-ASCII keys, mirroring tool-action arguments", () => {
    assert.throws(() => normaliseAuditPayload({ _internal: "no" }), /reserved/);
    assert.throws(() => normaliseAuditPayload({ аpiKey: "secret" }), /must be ASCII/);
  });

  it("labels its errors as audit payload rejections, not tool-action arguments", () => {
    assert.throws(() => normaliseAuditPayload({ apiKey: "secret" }), /Audit payload key/);
  });
});

describe("consent-lifecycle policy derivation (R-048/R-049/R-050)", () => {
  it("derives single-use for destructive proposals and reusable otherwise", () => {
    assert.equal(deriveConsumptionPolicy(true), "single-use");
    assert.equal(deriveConsumptionPolicy(false), "reusable");
  });

  it("derives a shorter default approval TTL for destructive proposals", () => {
    const destructiveTtl = deriveDefaultApprovalTtlMs(true);
    const nonDestructiveTtl = deriveDefaultApprovalTtlMs(false);
    assert.ok(destructiveTtl > 0);
    assert.ok(nonDestructiveTtl > 0);
    assert.ok(destructiveTtl < nonDestructiveTtl);
  });

  it("clamps a caller-supplied TTL override into the bounded range for that risk tier", () => {
    const defaultTtl = deriveDefaultApprovalTtlMs(false);
    assert.equal(clampApprovalTtlMs(undefined, false), defaultTtl);
    assert.equal(clampApprovalTtlMs(1, false), clampApprovalTtlMs(0, false));
    assert.ok(
      clampApprovalTtlMs(1, false) > 0,
      "a too-small override is clamped up, not accepted verbatim",
    );
    assert.ok(
      clampApprovalTtlMs(Number.MAX_SAFE_INTEGER, false) < Number.MAX_SAFE_INTEGER,
      "a too-large override is clamped down, not accepted verbatim",
    );
  });

  it("rejects non-finite or non-integer TTL overrides rather than silently falling back", () => {
    assert.throws(() => clampApprovalTtlMs(Number.NaN, false), /finite integer/);
    assert.throws(() => clampApprovalTtlMs(1.5, false), /finite integer/);
    assert.throws(() => clampApprovalTtlMs(Number.POSITIVE_INFINITY, false), /finite integer/);
  });

  it("treats now === expiresAt as already expired (fail-closed boundary)", () => {
    assert.equal(isApprovalExpired({ policy: "ttl", expiresAt: 1000 }, 999), false);
    assert.equal(isApprovalExpired({ policy: "ttl", expiresAt: 1000 }, 1000), true);
    assert.equal(isApprovalExpired({ policy: "ttl", expiresAt: 1000 }, 1001), true);
  });

  it("never treats a non-expiring policy as expired regardless of the clock", () => {
    assert.equal(isApprovalExpired({ policy: "non-expiring" }, Number.MAX_SAFE_INTEGER), false);
  });
});
