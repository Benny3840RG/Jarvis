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

- [x] ~~Write failing owner-isolation + bounded-limit + ordering tests first.~~ Superseded: Task 1's
      `toolActions`/reconciliation reads were blocked on #246/#247 (still unmerged), so the core slice
      (PR #248) reported those sources `"unsupported"` instead and added no new Convex query here. The
      `auditEvents.ts` time-ordered read this task originally described was implemented in Task 4 instead
      (see below), once it became clear the activity timeline — not the inbox — was what actually needed
      it.
- [x] Implement the minimal query surface. — N/A per above; nothing to implement for Task 1 itself.
- [x] Full Convex test suite green. — Verified as part of every subsequent task's full check.

### Task 2: Operations Inbox aggregator (blocked on Task 1)

**Files (new):** `src/operations/operationsInbox.ts`, `src/operations/inboxSeverity.ts` (pure, unit-tested
severity/ordering function), `tests/operationsInbox.test.ts`, `tests/inboxSeverity.test.ts`.

- [x] RED: per-source-failure-isolation test, owner-isolation test, deterministic-ordering test
      (including equal timestamps/severities), unavailable-not-zero test.
- [x] Implement `buildOperationsInbox()` composing existing reads concurrently (reminders, maintenance);
      `toolActions`/`reconciliation`/`quoteDelivery` reported `"unsupported"` with a concrete reason
      pending their blocking PRs.
- [x] GREEN, full check. (Landed as part of PR #248's core slice.)

### Task 3: HTTP + OpenAPI

**Files:** `src/http/operationsInboxController.ts` (new), `src/http/jarvisHttpModule.ts`,
`src/http/tokens.ts`, `src/http/app.ts`, `openapi/jarvis.openapi.json`,
`tests/operationsInboxHttp.test.ts` (new).

- [x] RED: auth, validation, per-source-degradation-in-response-shape, bounded-limit tests.
- [x] Implement `GET /api/v1/operations/inbox`.
- [x] OpenAPI + route-alignment tests green.

### Task 4: Activity timeline

**Files:** `convex/schema.ts` (additive `auditEvents.by_owner_and_created_at` index), `convex/auditEvents.ts`
(extend: `listActivityPage`), `src/operations/activityTimeline.ts` (new), `src/persistence/convexActivityEvents.ts`
(new), `src/operations/activityTimelineFactory.ts` (new), `src/http/activityTimelineController.ts` (new),
HTTP route `GET /api/v1/operations/activity`, `openapi/jarvis.openapi.json`, corresponding tests.

- [x] RED → GREEN: owner-isolation, cross-scope (not just one `scopeKey`), cursor-pagination-without-duplicates,
      deterministic-tie-break-for-equal-`createdAt`, and bounded-page-size tests
      (`convex/auditEvents.test.ts`); source-timestamp-not-render-time, safe-summary-whitelist,
      unknown-event-type-fallback-never-leaks-payload, and unavailable-not-thrown-not-empty tests
      (`tests/activityTimeline.test.ts`); HTTP auth/validation/pass-through/unavailable-in-200-body tests
      (`tests/activityTimelineHttp.test.ts`); Convex-adapter mapping tests (`tests/convexActivityEvents.test.ts`).
- [x] Implemented a bounded, cursor-paginated, owner-wide timeline reading only `auditEvents` for this
      slice — `toolExecutionReceipts` and `externalReconciliations` history (also named in the design doc)
      are deferred: the former has no owner-wide time-ordered index or query yet either, and the latter is
      PR #247's owned read surface, still unmerged. Adding either now would mean a second new index beyond
      the one this plan committed to, and/or consuming a not-yet-landed capability from another agent's
      branch — both against this slice's explicit constraints. Extending the timeline to those sources is
      a documented follow-up once #247 merges and an owner-wide receipts read exists.
- [x] Every event summary is built from a fixed per-`eventType` whitelist of known-safe fields only (never
      the raw payload); an unrecognized `eventType` — including any future one — falls back to a type-only
      summary, so a new emitter can never leak an unreviewed field into the timeline by accident.
- [x] GREEN: `npm run check` (type-check, lint, format, OpenAPI lint, full node + Convex/vitest suites) —
      all green.

### Task 5: Integration health

**Files:** `src/http/systemStatusService.ts` (extend, additively), `src/http/contracts.ts` (new
`IntegrationStatus` type, `SystemStatus.integrations`), `src/actions/toolExecution.ts` (new
`ToolExecutionService.isRegistered()`), `src/mcp/server.ts` (status tool output schema),
`openapi/jarvis.openapi.json`, corresponding tests.

- [x] RED → GREEN: `tests/systemStatusIntegrations.test.ts` proves the reported commissioning state is a
      live check against the actual injected `ToolExecutionService` (not a hardcoded constant — it flips
      when a different service instance is injected), distinguishes "tool execution not configured at all"
      from "configured but `quotes:send` specifically not registered" (both `not-commissioned`, with a
      distinct concrete reason each), and reports `commissioned` with no `reason` once the tool is actually
      registered.
- [x] Added exactly one evidence-backed line item: `quote-delivery` commissioning state, derived from
      `ToolExecutionService.isRegistered("quotes", "send")` — the same conditional registration
      `toolExecutionFactory.ts` already performs from the real quote-repository/email-provider/delivery-
      repository/PDF-artifact-repository bundle. No new live call to Outlook or any other external
      provider is made by this check.
- [x] Deliberately did not add a live "MCP catalogue registration success" check: constructing the real
      `createJarvisMcpServer()` requires a `JarvisApiClient` wired to a live HTTP base URL, so a runtime
      self-check from inside the status endpoint would mean either a new recursive HTTP call to this same
      process (not a pre-existing "already computed" fact, and arguably a new live call) or a nontrivial
      restructuring of MCP server bootstrap to capture a static success/failure fact — both beyond an
      "additive" extension for this slice. `tests/mcpOperationBinding.test.ts` and the OpenAPI/MCP
      route-alignment tests already prove the MCP tool surface is correct at CI time.
- [x] GREEN: `npm run check` — all green, including the MCP status tool output schema and OpenAPI
      `SystemStatus` schema updated to include `integrations` (both are `additionalProperties: false`,
      so the field had to be added in lockstep rather than silently accepted).

### Task 6: MCP read tools

**Files:** `src/mcp/server.ts`, `src/mcp/jarvisApiClient.ts`, `src/mcp/operationContract.ts`,
`tests/mcpOperationsInbox.test.ts` (already existed from the core slice), `tests/mcpActivityTimeline.test.ts`
(new, mirroring the same read-only-catalogue-assertion pattern).

- [x] `get_operations_inbox` — already implemented and tested in the core slice (Task 2/3).
- [x] `list_activity` — implemented: `JarvisApiClient.getOperationsActivity()` forwards `cursor`/`limit` as
      query params; registered as a read-only MCP tool with a `z.discriminatedUnion` output schema over
      `available`/`unavailable`; added to `MCP_TOOL_OPERATIONS` (the drift-guarded tool→OpenAPI-operation
      contract). RED → GREEN: `tests/mcpActivityTimeline.test.ts` (query forwarding, read-only-catalogue
      assertion, out-of-range `limit` rejected at the tool boundary before any HTTP call, unavailability
      surfaced truthfully rather than as an empty page).
- [x] `get_integration_health` — deliberately **not** added as a separate tool: `get_jarvis_status` (already
      MCP-exposed) now carries the new `integrations` field from Task 5, so a second tool would just be a
      duplicate read of the same `SystemStatus` object. Per the mission's own "names not mandatory if better
      ones already exist" — reusing `get_jarvis_status` avoids two tools answering the same question.
- [x] Proved no consequential tool was accidentally exposed: `tests/mcpActivityTimeline.test.ts` and
      `tests/mcpOperationsInbox.test.ts` both assert no `dismiss|acknowledge|resolve|approve|revoke|execute`
      prefixed tool exists in the catalogue; `tests/mcpOperationBinding.test.ts`'s registered-tools-equal-
      `MCP_TOOL_OPERATIONS`-keys drift guard still passes with `list_activity` added.

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
