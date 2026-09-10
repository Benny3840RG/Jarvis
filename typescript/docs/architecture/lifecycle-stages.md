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
`production-approved`, so neither stage is reachable today.** This describes the reader’s evidence limit, not a claim that no real delivery
or operator approval exists elsewhere. Making `commissioned` reachable means reading a
durable record of a real delivery (the `quoteDeliveryAttempts` ledger is the obvious
candidate); `production-approved` needs an operator approval record. Both are
follow-on work and require Jarvis acceptance.

Registration establishes the wiring represented by `configured` in this four-stage
contract. It does not independently certify end-to-end integration, authentication,
provider reachability or a successful delivery. No additional `integrated` stage is
asserted without a defined evidence source.

## Layer reasons

`layers.*` carries prose. Two claims were stale and have been corrected:

- **orchestration** previously said durable run state was pending. The Convex
  run/step store, worker-bound leases and fencing tokens exist. The Development
  Actions bridge also supplies durable admission and completion scheduling.
  Status does not inspect live commissioning evidence for those paths; source
  and offline tests establish implementation, not a completed live drill.
- **domains** previously said only that the business/workshop/home engines are
  non-durable prototypes. Read alone that implies business data is not durable,
  which is false — the trade-business record stores (clients, properties,
  projects, quotes, invoices, enquiries, errands) are durable. The reason now
  distinguishes the durable record stores from the synthetic-output prototype
  engines in `src/domains/`.

Layer reasons are still hand-maintained prose, not derived evidence. Treat them
as claims requiring review whenever the underlying area changes.

## Current matrix

| Area                            | Stage / state                  | Evidence                                                                                                                                                                                                                    | Open                                                                                                                         |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Persistence integrity (A6)      | `implemented`                  | Current main includes duplicate-ID validation, strict values and versioned persistence readers.                                                                                                                             | Release acceptance and live recovery remain separate evidence.                                                               |
| Orchestration durable run state | `implemented`                  | Convex run/step state, worker claims and Development Actions admission/completion scheduling have offline tests.                                                                                                            | No commissioning evidence reader is wired into status.                                                                       |
| Quote delivery                  | `configured` (when registered) | `ToolExecutionService.isRegistered("quotes", "send")`.                                                                                                                                                                      | No commissioning or production-approval evidence reader is wired; stronger stages are unknown here.                          |
| Business backup coverage (A2)   | `implemented`, partial v4      | v4 captures and verifies core, memory and JSON businessRecords including business settings; v1–v3 remain available. See [the v4 contract](backup-v4-contract.md) and [domain inventory](authoritative-domain-inventory.md). | Convex notesAndEvidence, orchestration and quoteAggregate/blob groups remain absent. Full recovery refuses partial archives. |
| Reasoning provider              | `configured` at most           | `resolveTotalityReasoningStatus` checks configuration presence.                                                                                                                                                             | This reader does not live-verify provider reachability.                                                                      |

Evidence packets from both workers are folded into this table only after Jarvis
accepts them. Neither worker marks its own row complete.
