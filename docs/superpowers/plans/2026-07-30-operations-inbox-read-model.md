# Operations Inbox, Activity Timeline & Integration Health — Implementation Plan

**Goal:** One owner-scoped, read-only operational view answering "what needs Benny's attention now, why,
and what evidence supports it," plus a durable activity timeline and evidence-backed integration health,
wired into the existing command-centre HUD. See the companion design doc:
`docs/superpowers/specs/2026-07-30-operations-inbox-read-model-design.md`.

**Status: Phase 1 (this document) only. Implementation is blocked — see below — and has not started.**

## Blocking dependencies

This slice's most operator-relevant sources (governed-action consent state, reconciliation escalations)
do not exist on `main` yet:

- **PR #246** (`agent/tool-action-consent-lifecycle`) — adds the `expired`/`revoked` states,
  `isApprovalExpired`, `approvalExpiresAt` this plan's "nearing expiry"/"expired or revoked" sources read.
  Open, green, awaiting Benny's review/merge.
- **PR #247** (`agent/reconciliation-operator-read-model`) — adds `listForOperator`/`getForOperator` this
  plan's "reconciliation escalations" source reads. Open, draft, still in its own RED phase.

Per the coordinating mission: wait for both to land, rebase this branch from the resulting `main`, *then*
begin Task 1. Do not modify either PR's branch. While waiting, this plan, its design doc, and any further
read-only repository investigation are the safe work to continue.

## Global constraints

- Read-only in this slice: no execute/approve/revoke/dismiss/acknowledge/delete/mutate anywhere in the
  inbox, timeline, or health surfaces.
- Reuse `src/briefs/brief.ts`'s existing domain reads (tasks, reminders, projects, quotes, maintenance) —
  do not add a second query path for any of them.
- Per-source failure isolation: one source's read failure must never fail the whole inbox/timeline/health
  response, and must never render as zero items.
- All new Convex reads: object-form functions, explicit args/returns validators, indexed bounded queries,
  no unbounded `.collect()`.
- No schema changes beyond one additive index (`auditEvents.by_owner_and_created_at`) unless investigation
  during implementation proves another is unavoidable.
- No fabricated telemetry of any kind (see the design doc's "explicitly out of scope" section).
- Extend `src/mcp/dashboard-v1.html`'s existing HUD; do not redesign it or touch its already-truthful
  Operations projection (#241/#242).

## InboxItem contract (draft, to be finalized against real field needs during Task 2)

```ts
type InboxItemKind =
  | "tool-action-awaiting-approval"
  | "tool-action-approval-expiring"
  | "tool-action-expired"
  | "tool-action-revoked"
  | "execution-failed"
  | "execution-indeterminate"
  | "reconciliation-escalated"
  | "quote-delivery-problem"
  | "task-overdue"
  | "reminder-overdue"
  | "maintenance-due";

type InboxSeverity = "critical" | "high" | "elevated" | "normal" | "informational";

interface InboxItem {
  itemId: string; // stable, derived from (kind, sourceRecordId) — never random per render
  ownerId: string; // scoping evidence, never returned to a different owner
  kind: InboxItemKind;
  severity: InboxSeverity;
  title: string;
  explanation: string; // concise, rule-derived, not free-form AI narration
  sourceSubsystem: "tool-actions" | "reconciliation" | "tasks" | "reminders" | "quotes" | "maintenance";
  sourceRecordId: string;
  createdAt: string;
  dueAt?: string;
  updatedAt: string;
  status: string; // the source record's own status vocabulary, not a re-invented one
  actionRequired: boolean;
  detailRef?: { kind: string; id: string }; // safe read-only detail target
  receiptRef?: string;
  reconciliationRef?: string;
}
```

## Severity derivation (deterministic, evidence-based)

Fixed order, highest first: (1) confirmed safety/external-effect uncertainty (indeterminate receipts,
active reconciliation escalations) → `critical`; (2) failed consequential actions → `high`; (3) expired
approvals / newly revoked actions requiring acknowledgement → `high`; (4) overdue customer/project
commitments (quote-delivery problems, overdue project blockers) → `elevated`; (5) approvals nearing expiry
→ `elevated`; (6) tasks/reminders/maintenance due soon → `normal`; (7) everything else → `informational`.
Tie-break for equal `(severity, dueAt)`: sort by `sourceSubsystem` (fixed alphabetical order), then
`itemId`. This exact ordering will be encoded as a single pure, unit-tested function — no per-item AI
judgment.

## Phase-ordered tasks (do not start until dependencies land — see above)

### Task 1: Convex read contracts (blocked on #246, #247)

**Files (new/modified):** `convex/schema.ts` (add `auditEvents.by_owner_and_created_at` index only),
`convex/auditEvents.ts` (new: bounded, owner-scoped, time-ordered read), `convex/toolActions.ts` (extend
`listRecent` or add a narrow `listAwaitingAttention` filtering by state/expiry window — decide from real
field needs, not preemptively), `convex/toolActions.test.ts`, `convex/auditEvents.test.ts` (new).

- [ ] Write failing owner-isolation + bounded-limit + ordering tests first.
- [ ] Implement the minimal query surface.
- [ ] Full Convex test suite green.

### Task 2: Operations Inbox aggregator (blocked on Task 1)

**Files (new):** `src/operations/operationsInbox.ts`, `src/operations/inboxSeverity.ts` (pure, unit-tested
severity/ordering function), `tests/operationsInbox.test.ts`, `tests/inboxSeverity.test.ts`.

- [ ] RED: per-source-failure-isolation test, owner-isolation test, deterministic-ordering test
      (including equal timestamps/severities), unavailable-not-zero test.
- [ ] Implement `buildOperationsInbox()` composing existing reads + Task 1's new reads concurrently.
- [ ] GREEN, full check.

### Task 3: HTTP + OpenAPI

**Files:** `src/http/operationsInboxController.ts` (new), `src/http/operationsInboxRequest.ts` (new),
`src/http/jarvisHttpModule.ts`, `src/http/tokens.ts`, `src/http/app.ts`, `openapi/jarvis.openapi.json`,
`tests/operationsInboxHttp.test.ts` (new).

- [ ] RED: auth, validation, per-source-degradation-in-response-shape, bounded-limit tests.
- [ ] Implement `GET /api/v1/operations/inbox`, `GET /api/v1/operations/inbox/{itemId}`.
- [ ] OpenAPI + route-alignment tests green.

### Task 4: Activity timeline

**Files:** `convex/auditEvents.ts` (extend), `src/operations/activityTimeline.ts` (new), HTTP route
`GET /api/v1/operations/activity`, corresponding tests.

- [ ] RED: dedup-by-stable-key test, cursor pagination test, source-timestamp-not-render-time test.
- [ ] Implement bounded, cursor-paginated, deduplicated timeline.
- [ ] GREEN.

### Task 5: Integration health

**Files:** `src/http/systemStatusService.ts` (extend, additively), corresponding tests.

- [ ] RED: evidence-timestamp test, uncommissioned-vs-unavailable distinction test.
- [ ] Extend with the additional evidence-backed line items described in the design doc.
- [ ] GREEN.

### Task 6: MCP read tools

**Files:** `src/mcp/server.ts`, `src/mcp/jarvisApiClient.ts`, `src/mcp/operationContract.ts`,
`tests/mcpOperationsInbox.test.ts` (new, mirroring `tests/mcpToolActionInspection.test.ts`'s exact
read-only-catalogue-assertion pattern).

- [ ] RED → implement `get_operations_inbox`, `list_activity`, `get_integration_health` (names subject to
      not colliding with any existing tool).
- [ ] Prove no consequential tool was accidentally exposed.

### Task 7: HUD wiring

**Files:** `src/mcp/dashboard-v1.html` (extend the existing Operations section; do not touch its already-
truthful #241/#242 content), corresponding widget/renderer tests.

- [ ] RED: stale-response/monotonic-generation test, hostile-text test, empty-vs-unavailable test.
- [ ] Wire real inbox/timeline/health data in; remove the session-only "Live operator feed" framing where
      it would now conflict with genuine durable timeline data (or clearly relabel it if kept alongside).
- [ ] Full repository CI + HUD build green.

### Task 8: Documentation + review + PR

- [ ] Update all affected docs (source-of-truth map, severity rules, timeline event meanings,
      health-state meanings, privacy boundary, unavailable-vs-empty, unsupported telemetry, operator
      recovery).
- [ ] Independent exact-head review; repair any Critical/Important finding with a regression test.
- [ ] Draft PR with full RED/GREEN evidence, six-line Copilot section, exact head SHA.

## Actions that remain unavailable (unchanged by this slice)

Everything the mission's final "Actions that remain unavailable" list states — no execution, no
approval/revocation from the inbox, no customer communication, no production deployment, no fabricated
telemetry.
