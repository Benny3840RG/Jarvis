import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MemoryChangeSet, MemoryChangeSetService } from "../src/memory/memoryChangeSets.js";
import {
  DEFAULT_RETENTION_POLICY,
  DELETION_LIMITS,
  buildDeletionReceipt,
  buildMemoryInventory,
  effectiveExpiry,
  governanceStatusFromChangeSet,
  planPromotion,
  previewRetention,
  proposePromotion,
  resolveRetentionPolicy,
  reviewIncomingClaim,
  validateGovernedMemoryRecord,
  type GovernedMemoryRecord,
} from "../src/memory/memoryGovernance.js";

const NOW = "2026-06-01T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

function daysBefore(days: number, from = NOW): string {
  return new Date(Date.parse(from) - days * DAY).toISOString();
}

function record(overrides: Partial<GovernedMemoryRecord> = {}): GovernedMemoryRecord {
  return {
    recordId: "rec-1",
    purpose: "Format quotes the way the owner reads them",
    scope: { kind: "project", projectId: "project-alpha" },
    category: "inferred_preference",
    content: "Quotes are easier to read with metric units",
    provenance: { source: "inference", sourceRef: "session-fixture-1", recordedBy: "agent" },
    consent: "pending",
    visibility: "user_visible",
    sensitivity: "none",
    confidence: 0.6,
    status: "proposed",
    revision: 1,
    lineage: { parentIds: [] },
    createdAt: daysBefore(10),
    expiresAt: null,
    pinned: false,
    activeDependents: [],
    ...overrides,
  };
}

function itemFor(preview: ReturnType<typeof previewRetention>, recordId: string) {
  const item = preview.items.find((entry) => entry.recordId === recordId);
  assert.ok(item, `missing preview item ${recordId}`);
  return item;
}

describe("governance metadata validation", () => {
  it("accepts a complete record", () => {
    assert.equal(validateGovernedMemoryRecord(record()).ok, true);
  });

  it("rejects hidden visibility, unknown fields and non-canonical timestamps", () => {
    const hidden = validateGovernedMemoryRecord({ ...record(), visibility: "hidden" });
    assert.equal(hidden.ok, false);
    const extra = validateGovernedMemoryRecord({ ...record(), profileScore: 3 });
    assert.equal(extra.ok, false);
    const badTime = validateGovernedMemoryRecord({ ...record(), createdAt: "2026-06-01" });
    assert.equal(badTime.ok, false);
    if (!badTime.ok) {
      assert.equal(badTime.recordId, "rec-1");
      assert.ok(badTime.issues.some((issue) => issue.startsWith("createdAt")));
    }
  });

  it("rejects out-of-range confidence", () => {
    assert.equal(validateGovernedMemoryRecord(record({ confidence: 1.5 })).ok, false);
  });
});

describe("retention policy", () => {
  it("uses the privacy-first defaults and leaves audit unconfigured", () => {
    const rules = DEFAULT_RETENTION_POLICY.rules;
    assert.deepEqual(rules.working, { kind: "ttl", ms: DAY });
    assert.deepEqual(rules.raw_episode, { kind: "ttl", ms: 30 * DAY });
    assert.deepEqual(rules.episodic_summary, { kind: "ttl", ms: 90 * DAY });
    assert.deepEqual(rules.inferred_preference, { kind: "ttl", ms: 180 * DAY });
    assert.deepEqual(rules.reflection, { kind: "ttl", ms: 180 * DAY });
    assert.equal(rules.audit.kind, "unconfigured");
  });

  it("freezes the defaults deeply so callers cannot lengthen them", () => {
    assert.ok(Object.isFrozen(DEFAULT_RETENTION_POLICY));
    assert.ok(Object.isFrozen(DEFAULT_RETENTION_POLICY.rules));
    for (const rule of Object.values(DEFAULT_RETENTION_POLICY.rules)) {
      assert.ok(Object.isFrozen(rule));
    }
    assert.throws(() => {
      (DEFAULT_RETENTION_POLICY.rules.raw_episode as { ms: number }).ms = 900 * DAY;
    }, TypeError);
    assert.deepEqual(DEFAULT_RETENTION_POLICY.rules.raw_episode, { kind: "ttl", ms: 30 * DAY });
  });

  it("requires a verification reference to configure audit retention", () => {
    assert.throws(() => resolveRetentionPolicy({ auditRetentionDays: 365 }), /verification/);
    const policy = resolveRetentionPolicy({
      auditRetentionDays: 400,
      auditVerificationRef: "owner-decision-fixture",
    });
    assert.deepEqual(policy.rules.audit, { kind: "ttl", ms: 400 * DAY });
  });

  it("only allows shortening ttl defaults", () => {
    assert.throws(() => resolveRetentionPolicy({ shortenDays: { raw_episode: 60 } }), /shortened/);
    assert.throws(() => resolveRetentionPolicy({ shortenDays: { fact: 10 } }), /shortened/);
    const policy = resolveRetentionPolicy({ shortenDays: { raw_episode: 7 } });
    assert.deepEqual(policy.rules.raw_episode, { kind: "ttl", ms: 7 * DAY });
  });

  it("only allows shortening the stale window", () => {
    assert.throws(() => resolveRetentionPolicy({ staleAfterDays: 181 }), /shortened/);
    assert.equal(resolveRetentionPolicy({ staleAfterDays: 180 }).staleAfterMs, 180 * DAY);
    assert.equal(resolveRetentionPolicy({ staleAfterDays: 30 }).staleAfterMs, 30 * DAY);
  });

  it("lets an explicit expiry shorten but never extend the window", () => {
    const later = record({ expiresAt: new Date(Date.parse(NOW) + 900 * DAY).toISOString() });
    assert.equal(
      effectiveExpiry(later),
      new Date(Date.parse(later.createdAt) + 180 * DAY).toISOString(),
    );
    const sooner = record({ expiresAt: daysBefore(1) });
    assert.equal(effectiveExpiry(sooner), daysBefore(1));
  });
});

describe("dry-run retention preview", () => {
  it("marks expired records and never executes deletion", () => {
    const preview = previewRetention({
      records: [record({ recordId: "old", createdAt: daysBefore(181) })],
      now: NOW,
    });
    assert.equal(preview.mode, "dry_run");
    assert.equal(preview.deletionsExecuted, 0);
    assert.equal(itemFor(preview, "old").action, "would_expire");
  });

  it("expires working memory after 24 hours", () => {
    const preview = previewRetention({
      records: [
        record({ recordId: "w-old", category: "working", createdAt: daysBefore(1.01) }),
        record({ recordId: "w-new", category: "working", createdAt: daysBefore(0.5) }),
      ],
      now: NOW,
    });
    assert.equal(itemFor(preview, "w-old").action, "would_expire");
    assert.equal(itemFor(preview, "w-new").action, "retain");
  });

  it("does not renew on use", () => {
    const used = record({
      recordId: "used",
      createdAt: daysBefore(200),
      lastUsedAt: daysBefore(0),
    });
    const preview = previewRetention({ records: [used], now: NOW });
    assert.equal(itemFor(preview, "used").action, "would_expire");
    assert.equal(effectiveExpiry(used), effectiveExpiry({ ...used, lastUsedAt: undefined }));
  });

  it("blocks expiry for pinned records, holds and active dependents", () => {
    const old = daysBefore(400);
    const preview = previewRetention({
      records: [
        record({ recordId: "pinned", createdAt: old, pinned: true }),
        record({
          recordId: "held",
          createdAt: old,
          hold: { reason: "owner review", placedAt: daysBefore(5) },
        }),
        record({ recordId: "depended", createdAt: old, activeDependents: ["rec-x"] }),
      ],
      now: NOW,
    });
    assert.deepEqual(itemFor(preview, "pinned").reasons, ["expired", "pinned"]);
    assert.deepEqual(itemFor(preview, "held").reasons, ["expired", "hold"]);
    assert.deepEqual(itemFor(preview, "depended").reasons, ["expired", "active_dependents"]);
    for (const id of ["pinned", "held", "depended"]) {
      assert.equal(itemFor(preview, id).action, "expiry_blocked");
    }
  });

  it("flags missing provenance for review", () => {
    const preview = previewRetention({
      records: [record({ recordId: "orphan", provenance: null })],
      now: NOW,
    });
    assert.equal(itemFor(preview, "orphan").action, "needs_review");
    assert.deepEqual(itemFor(preview, "orphan").reasons, ["missing_provenance"]);
  });

  it("does not retain sensitive inferences by default", () => {
    const preview = previewRetention({
      records: [
        record({ recordId: "sensitive", sensitivity: "sensitive", createdAt: daysBefore(1) }),
      ],
      now: NOW,
    });
    assert.equal(itemFor(preview, "sensitive").action, "would_discard_sensitive");
  });

  it("does not let a pin keep a sensitive inference", () => {
    const preview = previewRetention({
      records: [
        record({
          recordId: "pinned-sensitive",
          sensitivity: "sensitive",
          pinned: true,
          createdAt: daysBefore(1),
        }),
      ],
      now: NOW,
    });
    assert.equal(itemFor(preview, "pinned-sensitive").action, "would_discard_sensitive");
  });

  it("flags stale approved records", () => {
    const preview = previewRetention({
      records: [
        record({
          recordId: "stale-fact",
          category: "fact",
          status: "approved",
          provenance: { source: "user", sourceRef: "chat-fixture", recordedBy: "user" },
          createdAt: daysBefore(300),
        }),
        record({
          recordId: "fresh-fact",
          category: "fact",
          status: "approved",
          provenance: { source: "user", sourceRef: "chat-fixture", recordedBy: "user" },
          createdAt: daysBefore(300),
          lastVerifiedAt: daysBefore(3),
        }),
      ],
      now: NOW,
    });
    assert.deepEqual(itemFor(preview, "stale-fact").reasons, ["stale"]);
    assert.equal(itemFor(preview, "fresh-fact").action, "retain");
  });

  it("holds audit records pending policy rather than expiring them", () => {
    const preview = previewRetention({
      records: [record({ recordId: "audit", category: "audit", createdAt: daysBefore(800) })],
      now: NOW,
    });
    assert.equal(itemFor(preview, "audit").action, "retain_pending_policy");
  });

  it("reports invalid records instead of dropping them", () => {
    const preview = previewRetention({
      records: [{ recordId: "broken", category: "unknown" }],
      now: NOW,
    });
    const item = itemFor(preview, "broken");
    assert.equal(item.action, "needs_review");
    assert.deepEqual(item.reasons, ["invalid_record"]);
  });

  it("is deterministic regardless of input order", () => {
    const records = [
      record({ recordId: "a", createdAt: daysBefore(200) }),
      record({ recordId: "b" }),
      record({ recordId: "c", provenance: null }),
    ];
    const first = previewRetention({ records, now: NOW });
    const second = previewRetention({ records: [...records].reverse(), now: NOW });
    assert.deepEqual(first, second);
    assert.match(first.digest, /^[0-9a-f]{64}$/);
  });

  it("holds every record sharing an ID for review, independent of input order", () => {
    const records = [
      record({ recordId: "twin", createdAt: daysBefore(200) }),
      record({ recordId: "twin", category: "fact", createdAt: daysBefore(1) }),
      record({ recordId: "solo" }),
    ];
    const first = previewRetention({ records, now: NOW });
    const second = previewRetention({ records: [...records].reverse(), now: NOW });
    assert.deepEqual(first, second);
    const twins = first.items.filter((item) => item.recordId === "twin");
    assert.equal(twins.length, 2);
    for (const twin of twins) {
      assert.equal(twin.action, "needs_review");
      assert.deepEqual(twin.reasons, ["duplicate_record_id"]);
    }
    assert.equal(first.summary.would_expire, 0);
  });

  it("holds a valid record that shares its ID with an invalid one", () => {
    const valid = record({ recordId: "clash", createdAt: daysBefore(200) });
    const invalid = { ...valid, purpose: "" };
    const preview = previewRetention({ records: [valid, invalid], now: NOW });
    const clashes = preview.items.filter((item) => item.recordId === "clash");
    assert.equal(clashes.length, 2);
    assert.deepEqual(clashes.map((item) => item.reasons[0]).sort(), [
      "duplicate_record_id",
      "invalid_record",
    ]);
    assert.equal(preview.summary.would_expire, 0);
  });

  it("accepts a record that omits expiresAt", () => {
    const { expiresAt: _omitted, ...withoutExpiry } = record({ recordId: "no-expiry" });
    const validation = validateGovernedMemoryRecord(withoutExpiry);
    assert.equal(validation.ok, true);
    const preview = previewRetention({ records: [withoutExpiry], now: NOW });
    assert.equal(itemFor(preview, "no-expiry").action, "retain");
  });

  it("does not mutate its input", () => {
    const input = [record({ createdAt: daysBefore(400) })];
    const snapshot = structuredClone(input);
    previewRetention({ records: input, now: NOW });
    assert.deepEqual(input, snapshot);
  });
});

describe("contradiction review", () => {
  const existing = record({
    recordId: "units-old",
    subjectKey: "units.preferred",
    content: "Use metric units",
    status: "approved",
    createdAt: daysBefore(20),
  });

  it("marks a newer contradictory claim for review without overwriting", () => {
    const incoming = record({
      recordId: "units-new",
      subjectKey: "units.preferred",
      content: "Use imperial units",
      createdAt: daysBefore(1),
    });
    const before = structuredClone(existing);
    assert.deepEqual(reviewIncomingClaim([existing], incoming), {
      action: "mark_for_review",
      conflictsWith: ["units-old"],
    });
    assert.deepEqual(existing, before);

    const preview = previewRetention({ records: [incoming, existing], now: NOW });
    assert.equal(itemFor(preview, "units-new").action, "needs_review");
    assert.deepEqual(itemFor(preview, "units-new").conflictsWith, ["units-old"]);
    assert.equal(itemFor(preview, "units-old").action, "retain");
  });

  it("treats a restated claim as a duplicate", () => {
    const incoming = record({
      recordId: "units-dup",
      subjectKey: "units.preferred",
      content: "  use METRIC units ",
    });
    assert.deepEqual(reviewIncomingClaim([existing], incoming), {
      action: "duplicate",
      matches: "units-old",
    });
  });

  it("marks a restatement for review when another peer contradicts it", () => {
    const contradicting = record({
      recordId: "units-imperial",
      subjectKey: "units.preferred",
      content: "Use imperial units",
    });
    const incoming = record({
      recordId: "units-restated",
      subjectKey: "units.preferred",
      content: "Use metric units",
    });
    assert.deepEqual(reviewIncomingClaim([existing, contradicting], incoming), {
      action: "mark_for_review",
      conflictsWith: ["units-imperial"],
    });
  });

  it("ignores claims in a different scope", () => {
    const incoming = record({
      recordId: "units-other",
      subjectKey: "units.preferred",
      content: "Use imperial units",
      scope: { kind: "project", projectId: "project-beta" },
    });
    assert.deepEqual(reviewIncomingClaim([existing], incoming), { action: "no_conflict" });
  });
});

function changeSet(overrides: Partial<MemoryChangeSet> = {}): MemoryChangeSet {
  return {
    changeSetId: "cs-1",
    requestId: "req-1",
    projectId: "project-alpha",
    baseRevision: 3,
    state: "proposed",
    records: [],
    rationale: "fixture",
    proposedBy: "agent",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("consent-gated promotion", () => {
  const base = {
    changeSetId: "cs-1",
    requestId: "req-1",
    expectedRevision: 3,
    rationale: "Observed across three confirmed quotes",
  };

  it("stages an unverified assumption through the existing change-set service only", async () => {
    const calls: string[] = [];
    const service: MemoryChangeSetService = {
      stage: (input) => {
        calls.push("stage");
        assert.equal(input.proposedBy, "agent");
        assert.equal(input.projectId, "project-alpha");
        assert.equal(input.records[0]?.kind, "assumption");
        assert.equal(
          input.records[0]?.kind === "assumption" && input.records[0].status,
          "unverified",
        );
        return Promise.resolve(changeSet({ records: input.records }));
      },
      get: () => Promise.reject(new Error("unexpected get")),
      list: () => Promise.reject(new Error("unexpected list")),
      approve: () => {
        calls.push("approve");
        return Promise.reject(new Error("promotion must not approve"));
      },
      reject: () => Promise.reject(new Error("unexpected reject")),
      apply: () => {
        calls.push("apply");
        return Promise.reject(new Error("promotion must not apply"));
      },
    };
    const result = await proposePromotion(service, { ...base, record: record() });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["stage"]);
  });

  it("refuses a staging result that is not a proposal", async () => {
    await assert.rejects(
      proposePromotion(
        { stage: () => Promise.resolve(changeSet({ state: "approved", approvedBy: "user" })) },
        { ...base, record: record() },
      ),
      /unapproved proposal/,
    );
  });

  it("refuses declined consent, sensitive data, missing provenance and other categories", () => {
    const refusal = (overrides: Partial<GovernedMemoryRecord>) => {
      const plan = planPromotion({ ...base, record: record(overrides) });
      return plan.ok ? null : plan.refusal;
    };
    assert.equal(refusal({ consent: "declined" }), "consent_declined");
    assert.equal(refusal({ consent: "withdrawn" }), "consent_declined");
    assert.equal(refusal({ sensitivity: "sensitive" }), "sensitive_inference");
    assert.equal(refusal({ provenance: null }), "missing_provenance");
    assert.equal(refusal({ category: "fact" }), "not_promotable_category");
    assert.equal(refusal({ scope: { kind: "owner" } }), "not_project_scoped");
    assert.equal(refusal({ changeSetId: "cs-0" }), "already_linked");
  });

  it("derives proposed versus approved only from the change set", () => {
    assert.equal(governanceStatusFromChangeSet(null), "proposed");
    assert.equal(governanceStatusFromChangeSet(changeSet()), "proposed");
    assert.equal(governanceStatusFromChangeSet(changeSet({ state: "rejected" })), "rejected");
    assert.equal(
      governanceStatusFromChangeSet(changeSet({ state: "applied", approvedBy: "user" })),
      "approved",
    );
    assert.equal(governanceStatusFromChangeSet(changeSet({ state: "approved" })), "needs_review");
  });
});

describe("inventory and deletion receipts", () => {
  it("lists every record with purpose, source and expiry", () => {
    const inventory = buildMemoryInventory([
      record({ recordId: "b" }),
      record({ recordId: "a", provenance: null }),
    ]);
    assert.deepEqual(
      inventory.map((entry) => [entry.recordId, entry.source]),
      [
        ["a", "unknown"],
        ["b", "inference"],
      ],
    );
    assert.ok(inventory.every((entry) => entry.purpose.length > 0 && entry.effectiveExpiry));
  });

  it("states a dry run plainly and never claims backup erasure", () => {
    const preview = previewRetention({
      records: [record({ recordId: "old", createdAt: daysBefore(400) })],
      now: NOW,
    });
    const receipt = buildDeletionReceipt({ preview, executed: false });
    assert.match(receipt.statement, /no deletion was performed/);
    assert.deepEqual(receipt.entries, [
      {
        recordId: "old",
        primaryStore: "not_attempted",
        backups: "not_covered",
        derivedIndexesAndCaches: "not_covered",
      },
    ]);
    assert.deepEqual(receipt.limits, [...DELETION_LIMITS]);
    assert.equal(receipt.previewDigest, preview.digest);
  });

  it("only reports deletion as verified with read-back evidence", () => {
    const preview = previewRetention({
      records: [
        record({ recordId: "gone", createdAt: daysBefore(400) }),
        record({ recordId: "unknown", createdAt: daysBefore(400) }),
      ],
      now: NOW,
    });
    const receipt = buildDeletionReceipt({
      preview,
      executed: true,
      readBack: { gone: { absent: true, checkedAt: NOW } },
    });
    const byId = Object.fromEntries(receipt.entries.map((entry) => [entry.recordId, entry]));
    assert.equal(byId.gone?.primaryStore, "deleted_verified");
    assert.equal(byId.gone?.verifiedAt, NOW);
    assert.equal(byId.unknown?.primaryStore, "deletion_unverified");
    assert.match(receipt.statement, /^1 of 2/);
  });
});
