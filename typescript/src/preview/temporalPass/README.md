# Temporal PASS workflow prototype

**Status:** Experimental preview — not imported by any stable module.

## Purpose

Evaluate [Temporal](https://temporal.io) as a durable-execution engine for a
future autonomous BUILD → REVIEW → TEST → APPROVE → MERGE mission ("PASS")
workflow, before deciding whether to also adopt parts of Shannon's
multi-agent stack. **All AI/GitHub/LLM activities are mocked in Phase 1** —
this tests Temporal's durability, signal, and idempotency mechanics, not AI
behavior.

## Naming disambiguation

This "PASS workflow" is **unrelated** to "Jarvis PASS", the required `main`
branch-protection status check described in
`docs/operations/branch-protection.md` and
`docs/operations/dual-agent-coordination.md`. Same four letters, coincidence
only — this module doesn't touch branch protection or CI status checks.

## Non-authority disclaimer

This module — in particular `orchestrator/PolicyEngine.ts` — **grants no
Jarvis execution authority**. Per JARVIS-018 (no duplicate/parallel authority
implementations without explicit approval), any real integration must route
external side effects through the existing governed execution boundary
(ΩΣ / ToolAction / claim / receipt / reconciliation — see
`src/safety/safetyBinder.ts` and `src/orchestration/*`), not through this
prototype. `PolicyEngine` may never become an independent execution gate.

## Persistence scope: single host only

The idempotency store (`idempotency/idempotencyStore.ts`) and the mock
"GitHub" repo state (`temporal/activities/mockRepoState.ts`) are local JSON
files on whatever host the worker process runs on. This is intentional for
a single-worker preview — it reuses Jarvis's existing crash-safe atomic-write
primitives (`writePrivateJsonFile`, `JsonFileLock`) instead of adding a new
dependency — but it does **not** generalize past one host. Once Temporal
workers can run across multiple hosts or replicas (production use), a local
JSON file is the wrong authority for idempotency/external-state
reconciliation: two workers on different machines would each have their own
copy and could disagree. Convex (already Jarvis's shared durable store) or
an equivalent shared store is the right fit at that point — this file store
should not be carried into any multi-worker deployment as-is.

Separately, note what the "reboot" test (PASS-02) does and doesn't prove: it
kills and relaunches the Temporal server and worker as real OS processes
against the same on-disk SQLite file, which proves _process restart_
recovery. It does **not** prove sudden host power-loss durability —
`writePrivateJsonFile` fsyncs the temp file before renaming it into place,
but doesn't fsync the containing directory afterward, which is a narrow but
real POSIX durability gap in that shared primitive (used elsewhere in Jarvis
today, not introduced here). Don't read more into PASS-02 than "the worker
and server processes can die and come back."

## Isolation

- Lives entirely under `src/preview/`, per `docs/operations/preview-features.md`.
- Not imported by `src/http/`, `src/cli.ts`, or `src/index.ts`.
- `npm run check` passes with or without this module.
- Tests live under `typescript/tests/pass/`, outside the default
  `tests/*.test.ts` glob, so they don't run as part of `npm test`/`npm run
check`.
- No real GitHub API calls, no real credentials, no `main` branch touches.
  `getCurrentCommitSha`, `checkBranchProtection`, and `mergePR` stay local
  file-backed mocks (`temporal/activities/mockRepoState.ts`). `mergePR` is
  still the mock and is not the registered `github:merge-pull-request` tool.
  It cannot auto-merge a real pull request.

## Admitted real operation

Exactly one registered external effect is wired through the stable boundary:

- **`quotes:send`** (`executeGovernedQuoteSend`), the only non-merge tool in
  `ToolExecutionService` with an `externalProvider`.
- Registry path: `createGovernedExternalOperationFromEnv()` →
  `ToolExecutionService` → `createQuoteSendToolDefinition` →
  `QuoteEmailProvider` (`microsoft-graph-mail-connections-v1`). The activity
  calls `propose` or `execute` only. It does not approve, and it does not
  call the provider. The tool definition calls the provider only after the
  claim or eligibility gate.
- The activity returns the stable receipt. Provider acceptance is
  `indeterminate` with a reconciliation id; the activity does not send again.
- A PolicyEngine allowlist is not authority. The stable boundary rejects it
  before a claim or a provider call.
- `createGovernedExternalOperationFromEnv()` returns null unless persistence
  is Convex. The activity then refuses and does not call the provider.
- The workflow runs this only when `intent.context.governedQuoteSend` names
  an already-approved action, after owner approval and before the mocked
  merge. One Temporal attempt. No retry after `indeterminate`.

Live Microsoft Graph / Outlook commissioning is **unproven**. Tests use the
real `quotes:send` definition with a seam provider and in-memory durable
gates. They do not send email and do not contact Graph.

## Running the tests (opt-in, infra-heavy)

Requires the [Temporal CLI](https://docs.temporal.io/cli) on `PATH` (used to
spin up/kill a real local dev server for the Tier 2 tests below).

```bash
npm run test:temporal-pass
```

Two tiers:

- **Tier 1** (`duplicate-signal`, `side-effect`, `latest-candidate`,
  `bounded-loops`, `rejection`, `sha-race`, `github-veto`,
  `approval-timeout`, `timeout-race`, `replay-upgrade`): fast, in-process,
  via `@temporalio/testing`'s `TestWorkflowEnvironment.createLocal()`.
- **Tier 2** (`worker-kill`, `reboot`, `approval-recovery`,
  `merge-crash-recovery`): slower — spawns a real `temporal server
start-dev` process and a real worker process, and `SIGKILL`s them to
  prove the mission survives.

14 PASS acceptance criteria in total (`tests/pass/*.test.ts`), extending the
original 10-test spec with:

- `approval-timeout` (PASS-11) — `TestWorkflowEnvironment.createLocal()`
  runs on real wall-clock time, so the 72-hour approval wait needs its own
  coverage with a short, test-only override
  (`MissionIntent.constraints.approvalTimeoutMs`).
- `timeout-race` (PASS-12) — a late approval signal arriving after the
  mission has already timed out and closed must never resurrect it.
- `merge-crash-recovery` (PASS-13) — kills the worker in the exact window
  after the mock "GitHub" merge has already happened but before Temporal
  durably records the Activity's completion
  (`MissionIntent.scenario.mergeDelayMs`), proving the retry reconciles
  against the already-merged state instead of duplicating or erroring.
- `replay-upgrade` (PASS-14) — captures a real history from a mission
  parked at `AWAITING_APPROVAL`, then uses `Worker.runReplayHistory` to
  prove the current workflow code replays it cleanly, and that a
  deliberately incompatible code change (`tests/pass/fixtures/
brokenReplayWorkflow.ts`) is correctly rejected rather than silently
  corrupting a mission that a real Jarvis deploy landed underneath.

## Next steps (out of scope here)

Prove `quotes:send` across a worker crash: the provider may already have
accepted the draft while Temporal has not recorded the activity result, and
the retry must observe the stable reconciliation instead of sending again.
That proof needs the Temporal CLI and a durable Convex gate. It is not a
live Graph send.

Still mocked: build, review, rework, test, repair, `getCurrentCommitSha`,
`checkBranchProtection`, `notifyBenny`, and `mergePR`. Real read-only GitHub
PR reads, disposable-branch writes, and real Claude/Codex activities remain
out of scope.
