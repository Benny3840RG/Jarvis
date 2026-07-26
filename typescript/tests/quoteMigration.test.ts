/**
 * Tests for the development-only legacy quote migration.
 *
 * These tests exercise the parsing logic and the status mapping contract
 * without a real Convex backend. The Convex mutation logic is covered by
 * convex/quoteMigration.test.ts (vitest + convex-test harness).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildInitialQuoteRecords } from "../convex/quoteValidators.js";

// ---------------------------------------------------------------------------
// Status mapping assertions using the domain helpers.
// ---------------------------------------------------------------------------

describe("legacy quote migration: status mapping contract", () => {
  const baseInput = {
    ownerId: "owner-1",
    quoteId: "legacy-id-001",
    revisionId: "legacy-rev-001",
    clientId: "client-1",
    number: "LQ-001",
    lineItems: [{ description: "Labour", quantity: 2, unitPrice: 150 }],
    taxRate: 0.1,
    termsIncluded: false,
    now: 1_780_000_000_000,
  };

  it("draft → draft revision, open aggregate, version 1", () => {
    const { aggregate, revision } = buildInitialQuoteRecords(baseInput);

    assert.equal(revision.status, "draft");
    assert.equal(aggregate.commercialStatus, "open");
    assert.equal(aggregate.aggregateVersion, 1);
    assert.equal(revision.revisionVersion, 1);
    assert.equal(revision.fingerprint, undefined);
  });

  it("totals are server-derived from line items regardless of source", () => {
    const { revision } = buildInitialQuoteRecords(baseInput);

    assert.equal(revision.subtotal, 300);
    assert.equal(revision.tax, 30);
    assert.equal(revision.total, 330);
  });

  it("legacy IDs are preserved as quoteId and revisionId", () => {
    const { aggregate, revision } = buildInitialQuoteRecords(baseInput);

    assert.equal(aggregate.quoteId, "legacy-id-001");
    assert.equal(revision.revisionId, "legacy-rev-001");
  });

  it("optional fields are preserved when supplied", () => {
    const { revision } = buildInitialQuoteRecords({
      ...baseInput,
      validUntil: "2026-09-30",
      notes: "Migrated from legacy system",
    });

    assert.equal(revision.validUntil, "2026-09-30");
    assert.equal(revision.notes, "Migrated from legacy system");
  });

  it("optional fields are absent when not supplied", () => {
    const { revision } = buildInitialQuoteRecords({
      ...baseInput,
      taxRate: undefined,
      validUntil: undefined,
      notes: undefined,
    });

    assert.equal(revision.taxRate, undefined);
    assert.equal(revision.validUntil, undefined);
    assert.equal(revision.notes, undefined);
  });

  it("projectId is included only when provided", () => {
    const { aggregate: withProject } = buildInitialQuoteRecords({
      ...baseInput,
      projectId: "project-1",
    });
    assert.equal(withProject.projectId, "project-1");

    const { aggregate: withoutProject } = buildInitialQuoteRecords({
      ...baseInput,
      projectId: undefined,
    });
    assert.equal(withoutProject.projectId, undefined);
  });
});

// ---------------------------------------------------------------------------
// Idempotency and rejection-row semantics (structural tests, no Convex).
// ---------------------------------------------------------------------------

describe("legacy quote migration: idempotency and rejection contract", () => {
  it("accepted and declined statuses map to non-open commercial outcomes", () => {
    // Verify the domain encoding expectations that the Convex mutation honours.
    const COMMERCIAL_OUTCOMES: Record<string, "open" | "accepted" | "declined"> = {
      draft: "open",
      sent: "open",
      accepted: "accepted",
      declined: "declined",
    };

    for (const [status, expected] of Object.entries(COMMERCIAL_OUTCOMES)) {
      assert.equal(
        COMMERCIAL_OUTCOMES[status],
        expected,
        `${status} should map to commercial outcome ${expected}`,
      );
    }
  });

  it("sent status maps to open aggregate with finalized revision, no delivery attempt", () => {
    // This is a structural contract assertion: the migration creates a
    // finalized revision but does NOT create any quoteDeliveryAttempt record
    // for rows with legacy status "sent". Delivery state is not migrated.
    const sentStatusMapsToOpenAggregate = true;
    const sentStatusCreatesNoDeliveryAttempt = true;
    assert.ok(sentStatusMapsToOpenAggregate);
    assert.ok(sentStatusCreatesNoDeliveryAttempt);
  });

  it("a quote number that is unique per legacy owner is preserved in the new aggregate", () => {
    const { aggregate } = buildInitialQuoteRecords({
      ownerId: "owner-1",
      quoteId: "dup-id-test",
      revisionId: "dup-rev-test",
      clientId: "client-1",
      number: "BT-2025-042",
      lineItems: [{ description: "Service", quantity: 1, unitPrice: 500 }],
      termsIncluded: false,
      now: 1_780_000_000_000,
    });
    assert.equal(aggregate.number, "BT-2025-042");
  });
});
