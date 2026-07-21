# Agent simulation subsystem

This directory contains an **isolated, in-memory simulation** of a governed
autonomous orchestrator that coordinates three simulated domains — workshop,
business, and home — behind a safety envelope, an orchestration graph, an
adaptive learning layer, a Z-state autonomy gate, a reliability health monitor,
and a memory-consolidation layer.

## What it is

- A self-contained subsystem under the `src/agent/` namespace. It does **not**
  import or modify the maintained Jarvis runtime (task/reminder CLI, HTTP, MCP,
  persistence). It collides with nothing.
- Fully typed and covered by `tests/agentSystem.test.ts`, and runnable in two
  ways:
  - `npm run agent:check` — a one-shot run that drives one scenario ("Start job
    j1") through parse → plan → execute → learn → consolidate → validate and
    prints a report plus an ALL VALIDATIONS PASSED / FAILURES line.
  - `npm run agent:repl` — an **interactive** session that keeps one in-memory
    system alive and lets you type utterances (`start job j1`, `prepare job j1`,
    `complete job j1`), plus `snapshot`, `help`, and `exit`. Each utterance is
    parsed, planned, executed, and learned from live. State lasts only for the
    session (nothing is persisted).

## What it is NOT

- **Not persistent.** Every engine holds in-memory state that resets each run.
- **Not real-world safety.** The `SafetyEnvelope` enforces simulation rules
  (e.g. "tool use requires a toolId"). It is not PPE, hazard, or machine-safety
  enforcement and must never be relied on as such.
- **Not part of the maintained operational baseline.** Per
  [`docs/architecture/scaffold-and-runtime-boundaries.md`](../../docs/architecture/scaffold-and-runtime-boundaries.md),
  this is a prototype. Promoting any part of it to a durable product feature
  requires a focused requirement, a durable contract, tests, and the normal
  branch/PR process.

## Layout

| File                                                            | Role                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `conversationService.ts`                                        | Text → `ParsedInput` (intent + entities)                             |
| `domainRouter.ts` + `*Engine.ts`                                | Routes actions to workshop/business/home engines                     |
| `graph.ts`                                                      | Config-driven intent → orchestration nodes                           |
| `safetyEnvelope.ts`                                             | Simulation safety + cross-domain consistency checks                  |
| `orchestrator.ts`                                               | Plans and executes, consulting safety + Z-state                      |
| `learningEngine.ts` / `predictionEngine.ts`                     | Interaction history, per-intent stats, next-intent hints             |
| `workflowGenerator.ts` / `ruleEvolution.ts` / `zState.ts`       | Advisory autonomy proposals, gated on safety + reliability + history |
| `healthMonitor.ts`                                              | Reliability status from metrics                                      |
| `memoryTypes.ts` / `memoryConsolidator.ts` / `memoryManager.ts` | Short/long-term memory, bounded pruning, lineage                     |
| `validationSuite.ts` / `systemCheck.ts`                         | Self-audit and end-to-end scenario                                   |
| `system.ts` / `main.ts`                                         | Composition root and runnable entry                                  |

## Stage coverage

Each stage from the Jarvis v2 checklist, mapped to where it lives here — implemented against the code that actually exists, no invented real-world safety:

1. **Safety envelope** — `safetyEnvelope.ts`: tool/quantity rules, business `complete_job` consistency, error-output detection, and a home-scene-requires-completed-job cross-domain rule.
2. **Intent mapping** — `conversationService.ts`: canonical job intents with synonym phrasings (`start`/`kick off`/`begin`, `prepare`/`prep`/`set up`, `complete`/`finish`/`close`) plus `jobId` extraction.
3. **Orchestration graph** — `graph.ts`: config-driven intent → weighted nodes (`defaultGraphConfig`).
4. **Adaptive layer** — `learningEngine.ts` (per-intent success stats) and `predictionEngine.ts` (lifecycle next-intent prediction).
5. **Autonomy layer** — `workflowGenerator.ts` / `ruleEvolution.ts`: data-driven, advisory proposals that are never auto-applied.
6. **Reliability** — `healthMonitor.ts`: metric-derived status that gates autonomy (critical health blocks activation).
7. **Memory** — `memoryConsolidator.ts` / `memoryManager.ts`: bounded short-term pruning, orphan-free lineage, usable profiles.
8. **Z-state** — `zState.ts`: activates only when safety is ok, reliability is healthy, and enough history exists.
9. **Validation suite** — `validationSuite.ts`: per-subsystem self-checks.
10. **Full system test** — `systemCheck.ts` + `autonomyDemo.ts`: end-to-end scenario and governed-autonomy demonstration, exercised by `npm run agent:check` and `tests/agentSystem.test.ts` / `tests/agentMemory.test.ts`.
