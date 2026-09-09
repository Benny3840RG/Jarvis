# Lifecycle stages and the runtime-truth matrix

Jarvis status output must not overstate what has actually happened. This document
defines the four stages `GET /api/v1/status` and `get_jarvis_status` report, the
evidence each one requires, and the current per-capability assessment.

## The four stages

| Stage                 | Claim                                                                                           | Evidence required                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `implemented`         | The code exists and is covered by offline tests.                                                | Source + passing tests in CI.                                                                             |
| `configured`          | Every dependency and credential this deployment needs is present and wired.                     | A runtime check of the actual wiring — e.g. the tool is registered on the running `ToolExecutionService`. |
| `commissioned`        | The capability has been exercised against the real external system and the result was recorded. | A durable record of a real interaction (a completed delivery, a recorded drill), not a config flag.       |
| `production-approved` | A human approved production use.                                                                | An operator approval record.                                                                              |

**The one rule: a stronger stage is never inferred from a weaker one.**

- Code existing does not mean it is wired.
- Being wired does not mean the external system has ever been reached.
- Reaching it once does not mean anyone approved production use.

`IntegrationStatus.stage` reports the highest stage with evidence _of that kind_.
`IntegrationStatus.status` (`commissioned` / `not-commissioned`) is retained for
existing consumers and is **derived** from `stage` via
`integrationStatusFromStage`, so the two can never disagree.

### Why registration is not commissioning

`quotes:send` is registered by `toolExecutionFactory.ts` only when the whole
quote-delivery dependency bundle resolves (Convex, quote repository, email
provider, delivery repository, PDF artifact repository). That is real evidence —
but only that the bundle is wired. It says nothing about whether Outlook has ever
accepted a message, and it carries no operator approval. Reporting it as
`commissioned` was an upward inference; it now reports `configured`.

**There is currently no wired evidence source for `commissioned` or
`production-approved`, so neither stage is reachable today.** That is the honest
state, not a gap to paper over. Making `commissioned` reachable means reading a
durable record of a real delivery (the `quoteDeliveries` ledger is the obvious
candidate); `production-approved` needs an operator approval record. Both are
follow-on work and require Jarvis acceptance.

## Layer reasons

`layers.*` carries prose. Two claims were stale and have been corrected:

- **orchestration** previously said durable run state was pending. It is not:
  `convex/orchestrationState.ts` persists runs and steps with worker-bound leases
  and fencing tokens, and `src/orchestration/convexStateBoundary.ts` composes it,
  both covered by offline tests. What _is_ still true is that this composition is
  wired into no CLI/HTTP/MCP/scheduler ingress path and has never run against a
  deployment.
- **domains** previously said only that the business/workshop/home engines are
  non-durable prototypes. Read alone that implies business data is not durable,
  which is false — the trade-business record stores (clients, properties,
  projects, quotes, invoices, enquiries, errands) are durable. The reason now
  distinguishes the durable record stores from the synthetic-output prototype
  engines in `src/domains/`.

Layer reasons are still hand-maintained prose, not derived evidence. Treat them
as claims requiring review whenever the underlying area changes.

## Current matrix

| Area                            | Stage / state                  | Evidence                                                                                                                                                                                                                                                     | Open                                                                                                                                                                         |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence integrity (A6)      | `implemented`                  | PR #483 @ `c1c640d` — duplicate task/reminder id rejection + proof every supported legacy format stays readable. Branch `agent-persistence-hardening` — non-finite timestamps, non-finite/cyclic assistant state, validate-before-write, no-rewrite-on-read. | The two touch the same file (`src/persistence/document.ts`) on different lines and cannot merge independently; an assembly step is required. Codex review outstanding.       |
| Orchestration durable run state | `implemented`                  | `convex/orchestrationState.ts` + `convex/orchestrationState.test.ts`; `src/orchestration/convexStateBoundary.ts` + `tests/orchestrationDurability.test.ts`.                                                                                                  | Wired into no ingress path. Isolated-ingress commissioning bootstrap is PR #481; the recorded development-backend drill is not run.                                          |
| Quote delivery                  | `configured` (when registered) | `ToolExecutionService.isRegistered("quotes","send")`.                                                                                                                                                                                                        | No commissioning evidence source is wired; `commissioned` unreachable.                                                                                                       |
| Business backup coverage (A2)   | `implemented` (v1–v3 only)     | `src/backup/backup.ts` covers state/tasks/reminders + five memory domains.                                                                                                                                                                                   | The seven cross-referenced business domains are not covered. Business settings, notes, approval/evidence state, delivery ledger and artifact references are not inventoried. |
| Reasoning provider              | `configured` at most           | `resolveTotalityReasoningStatus` reads env-var presence only.                                                                                                                                                                                                | Never live-verified; documented as such in `contracts.ts`.                                                                                                                   |

Evidence packets from both workers are folded into this table only after Jarvis
accepts them. Neither worker marks its own row complete.
