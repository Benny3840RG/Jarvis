# Operations Inbox, Activity Timeline & Integration Health — Design

## Objective

Answer, truthfully and only from durable evidence: *what genuinely needs Benny's attention now, why,
and what evidence supports it?* Add a bounded activity timeline of real events, and replace cosmetic
"healthy" badges with evidence-backed integration status. Wire all three into the existing command-centre
HUD without redesigning it.

## What already exists (do not duplicate)

- **`src/briefs/brief.ts`** already aggregates overdue/upcoming reminders, open tasks, active projects,
  quote pipeline, and maintenance due/due-soon into one bounded, capped digest (`BRIEF_HIGHLIGHT_LIMIT = 5`
  per section). This is the correct existing severity/aggregation precedent — the inbox should read the
  *same underlying domain reads* `brief.ts` already does, not add a parallel query path for tasks,
  reminders, projects, quotes, or maintenance.
- **`src/http/systemStatusService.ts`** already returns a real `SystemStatus`: a static `LAYERS` map
  (architecture-completeness, not per-integration health), a live `reconciliationHealth()` call, and
  `provider.reachability`/`authentication`/`schemaCompatibility` derived from an actual successful
  persistence read. This is the existing "Integration Health" precedent to extend, not replace.
- **PR #241/#242 (merged, `main`)** already projected the daily brief into `src/mcp/dashboard-v1.html` as
  a real "Operations" section (active projects, quote register, maintenance, a quote inspector detail
  view) — see `docs/superpowers/specs/2026-07-30-dashboard-operations-projection-design.md`. Counts and
  detail selection in the HUD are **already truthful**, not fabricated. Do not re-implement this.
- **`auditEvents`** (Convex, `ownerId`/`scopeKey`/`eventType`/`actor`/`payload`/`createdAt`) already
  records `tool.action.proposed/approved/rejected/approval-expired/revoked` (from the consent-lifecycle
  slice) as free-text `eventType` + JSON `payload`, scoped by `ownerId` + `scopeKey` (a project-ish key),
  with indexes `by_owner_and_scope_key` and `by_owner_and_request_id` only — **no time-ordered index**.
- **`toolExecutionReceipts`** and **`externalReconciliations`** are the durable execution/delivery
  evidence tables (owner + action-id indexed).

## Confirmed gaps (evidence, not assumption)

1. **The "live" activity feed is session-only, not durable.** `dashboard-v1.html`'s `activity(title, detail)`
   function (`state.activities.unshift(...)`, capped to 7) is pure client-side JS state, reset on every
   page load, never read from or written to any server table. It is explicitly documented as an
   intentional prior design choice ("Keep the live activity feed session-only" — the #241/#242 design
   doc). It reads as a timeline but isn't one across sessions or devices. This mission's "Live Timeline"
   requirement is a deliberate, explicit expansion beyond that prior decision, not a bug fix.
2. **The dashboard snapshot is all-or-nothing on failure.** Per the #241/#242 design doc: "if any required
   read fails, the existing safe MCP error is returned rather than a partial snapshot." There is currently
   no per-source degradation model anywhere in the read path. This directly conflicts with this mission's
   explicit requirement that one unavailable source must not poison the whole inbox.
3. **No unified severity/urgency concept exists anywhere.** `brief.ts` groups by domain (tasks, reminders,
   projects, quotes, maintenance) but has no cross-domain ranking, and has no concept of governed-action
   consent state, reconciliation escalation, or execution-receipt failure at all (those didn't exist when
   `brief.ts` was written).
4. **`auditEvents` cannot be read as a bounded, time-ordered, cross-scope feed today.** Its only indexes
   are scoped by `scopeKey` or `requestId`; a genuine "recent activity across everything this owner can
   see" read would require either an unbounded `.collect()` (forbidden) or a new index.
5. **No existing owner-scoped read exists yet for governed `ToolAction` approaching/at either boundary**
   (nearing expiry, expired, revoked, awaiting approval) as a queryable set — `listRecent` (from the
   consent-lifecycle slice, PR #246) lists recent actions but has no "state = approved AND
   approvalExpiresAt within window" filter, and no severity concept.
6. **No existing owner-scoped read exists yet for reconciliation escalations** — that is exactly what PR
   #247 (`listForOperator`/`getForOperator`) is building, in progress, not yet merged.

## Blocking dependencies (why this is a plan-only slice for now)

- **PR #246** (`agent/tool-action-consent-lifecycle`, this author, unmerged): the inbox's "approvals
  nearing expiry," "expired or revoked actions requiring acknowledgement" sources need the `expired`/
  `revoked` states, `isApprovalExpired`, and `approvalExpiresAt` fields it adds. They do not exist on
  `main` yet.
- **PR #247** (`agent/reconciliation-operator-read-model`, Codex, unmerged, still RED): the inbox's
  "reconciliation escalations" source needs `listForOperator`/`getForOperator`, which do not exist on
  `main` yet.

Per the coordinating mission's own instruction, implementation waits for both to land and for this branch
to rebase from the resulting `main`. This document and its companion plan are the safe, non-overlapping
work to do in the meantime.

## Proposed architecture (for the implementation phase, once unblocked)

A new, read-only `operationsInbox` module (`src/operations/` — name follows the existing `src/briefs/`,
`src/reconciliation/` per-concern convention) that:

- calls the *same* domain reads `brief.ts` already calls (tasks, reminders, projects, quotes, maintenance),
  plus `ToolActionService.list()` (approved/nearing-expiry/expired/revoked) and the new reconciliation
  read store from #247, **concurrently**, each wrapped so a single source's failure produces a
  `{status: "unavailable", reason}` marker for *that source only* rather than throwing;
- derives one `InboxItem[]` per source using explicit, documented rules (never vague AI-generated text —
  every field traces to a stored record and a fixed rule);
- sorts deterministically by the mission's severity order, with an explicit tie-break (source, then
  itemId) for equal timestamps/severities;
- never invents a zero — an unavailable source contributes no items and is reported as unavailable, not
  as "0 items needing attention."

The activity timeline reads `auditEvents` (once a `by_owner_and_created_at` index is added — additive,
no migration, matches `state-target-registry`'s existing indexing conventions) plus `toolExecutionReceipts`
and `externalReconciliations` history, deduplicated by a stable `(source, sourceRecordId, eventType)` key
so the same underlying receipt/reconciliation transition can't appear twice from two projections.

Integration health extends `SystemStatusService`'s existing real checks (persistence reachability,
reconciliation health) with additional evidence-backed line items (MCP catalogue registration success,
Outlook/quote-delivery commissioning state already computed by `toolExecutionFactory.ts`'s conditional
`quotes:send` registration) — no new live external-provider calls, no percentages without a documented
formula.

## Explicitly out of scope for the first slice

Everything the mission's "Not allowed" list already states: execute/approve/revoke/dismiss/acknowledge/
delete/mutate from the inbox; automatic retries of external writes; a new project-management subsystem for
"Current Objective" (the existing current-task concept is truthful and sufficient); any percentage-based
health score without a documented source calculation.
