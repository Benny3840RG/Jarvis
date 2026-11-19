# Memory Governance V1 (#838)

`src/memory/memoryGovernance.ts` is the first bounded slice. It is pure. The
only side effect it can cause is `MemoryChangeSetService.stage`, which adds a
proposal. It adds no memory store, no HTTP route and no Convex schema.

## Model

Each governed record carries a purpose, a scope (project, session or owner), a
category, provenance (nullable, so a gap shows up for review instead of being
dropped), consent, visibility (`user_visible` only, so V1 has no hidden
profile), sensitivity, confidence, status, revision, lineage, creation time,
an optional explicit expiry, pin/hold/dependents and an optional linked change
set. Schemas are strict: unknown fields fail validation.

## Retention defaults

| Category            | Default                                       |
| ------------------- | --------------------------------------------- |
| working             | 24 hours                                      |
| raw_episode         | 30 days                                       |
| episodic_summary    | 90 days                                       |
| inferred_preference | 180 days                                      |
| reflection          | 180 days                                      |
| fact, decision      | until changed (reviewed when stale, 180 days) |
| audit               | unconfigured: needs a verification reference  |

- Expiry is counted from `createdAt`. `lastUsedAt` is ignored, so reuse never
  renews a memory.
- Audit records are never deletion candidates while audit retention is
  unconfigured, even with an explicit `expiresAt`. A configured audit retention
  is capped at 36,500 days.
- An explicit `expiresAt` can shorten the window but never lengthen it. Policy
  overrides can only shorten the ttl defaults and the 180-day stale window.
- Sensitive inferences are not retained: the preview marks them
  `would_discard_sensitive` unless a hold applies. A pin does not keep them:
  pinning is a convenience, while a hold is an explicit retention obligation.
  A sensitive record that also needs review (missing provenance, contradiction
  or stale) is held as `needs_review` first and is never a deletion candidate.
- The inventory is a projection of caller-supplied records and shows `status`
  as given. The authoritative proposed-vs-approved state comes from the linked
  change set via `governanceStatusFromChangeSet`.

## Dry-run preview

`previewRetention({ records, now })` returns `mode: "dry_run"` and
`deletionsExecuted: 0`, with one item per input record (invalid records are
reported as `needs_review`). Expired records with a pin, hold or active
dependents come back as `expiry_blocked`. Missing provenance, contradictions
and stale approved records come back as `needs_review`, even when expired:
review takes precedence over expiry, so they are never deletion candidates. Records that share a
`recordId`, including with an invalid record, are all held as `needs_review` (`duplicate_record_id`) rather than
letting input order pick one. The output is sorted with a full tie-break and
carries a SHA-256 digest over every other field, so the same inputs always
give the same result. `buildDeletionReceipt` refuses a preview whose digest no
longer matches.
`DEFAULT_RETENTION_POLICY` is deeply frozen.

## Contradictions

A newer claim with the same `subjectKey` and scope but different content is
marked for review against the existing record IDs. The existing record is never
overwritten. A claim restated with only case or whitespace changes counts as a
duplicate, unless another peer on the same subject contradicts it: any
contradiction takes precedence, so a restatement never bypasses review.

## Consent-gated promotion

`planPromotion` / `proposePromotion` turn a non-sensitive, project-scoped
lesson or preference into a **proposed** change set holding an `unverified`
assumption. They refuse declined or withdrawn consent, sensitive data, missing
provenance, records that already have a change set, and categories that cannot
be promoted. They never call `approve` or `apply`. The approval step stays
with the user through the existing change-set flow.
`governanceStatusFromChangeSet` derives proposed versus approved only from the
change set. An approval not recorded as `approvedBy: "user"` maps to
`needs_review`.

## Deletion receipts and limits

`buildDeletionReceipt` never claims more than it can show:

- A dry run reports `not_attempted` for every target.
- An executed run reports `deleted_verified` only for records with read-back
  evidence that they are absent. All others are `deletion_unverified`.
- Backups and derived stores are always `not_covered`.

Known limits (also returned as `receipt.limits`):

- Backup archives already written are not modified. Archive v4 captures
  memory history.
- Any retention kept by the hosted Convex deployment is unverified.
- Derived logs and prompt context are not traced. No search or embedding
  index existed at the V1 base.

## Out of scope for V1

The following are not part of this slice: live pruning or deletion, backup
erasure, migrating existing memories into governed records, an HTTP/HUD
surface for the inventory, and policy self-modification. Each needs its own
owner-authorised follow-up.
