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

## Isolation

- Lives entirely under `src/preview/`, per `docs/operations/preview-features.md`.
- Not imported by `src/http/`, `src/cli.ts`, or `src/index.ts`.
- `npm run check` passes with or without this module.
- Tests live under `typescript/tests/pass/`, outside the default
  `tests/*.test.ts` glob, so they don't run as part of `npm test`/`npm run
check`.
- No real GitHub API calls, no real credentials, no `main` branch touches —
  every external system (`getCurrentCommitSha`, `mergePR`,
  `checkBranchProtection`) is a local, file-backed mock
  (`temporal/activities/mockRepoState.ts`).

## Running the tests (opt-in, infra-heavy)

Requires the [Temporal CLI](https://docs.temporal.io/cli) on `PATH` (used to
spin up/kill a real local dev server for the Tier 2 tests below).

```bash
npm run test:temporal-pass
```

Two tiers:

- **Tier 1** (`duplicate-signal`, `side-effect`, `latest-candidate`,
  `bounded-loops`, `rejection`, `sha-race`, `github-veto`,
  `approval-timeout`): fast, in-process, via
  `@temporalio/testing`'s `TestWorkflowEnvironment.createLocal()`.
- **Tier 2** (`worker-kill`, `reboot`, `approval-recovery`): slower — spawns
  a real `temporal server start-dev` process and a real worker process,
  and `SIGKILL`s them to prove the mission survives.

11 PASS acceptance criteria in total (`tests/pass/*.test.ts`), extending the
original 10-test spec with `approval-timeout` (PASS-11), since
`TestWorkflowEnvironment.createLocal()` runs on real wall-clock time and the
72-hour approval wait needs its own coverage with a short, test-only
override (`MissionIntent.constraints.approvalTimeoutMs`).

## Next steps (out of scope here)

Real read-only GitHub PR → real disposable branch with write operations →
real Claude/Codex activities → benchmark on the target hardware → decide
Temporal alone vs. Temporal + Shannon components vs. full Shannon backend.
