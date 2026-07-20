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
- Fully typed and covered by `tests/agentSystem.test.ts`, and runnable end to
  end with `npm run agent:check`, which drives one scenario ("Start job j1")
  through parse → plan → execute → learn → consolidate → validate and prints a
  report plus an ALL VALIDATIONS PASSED / FAILURES line.

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
