# Agent simulation subsystem

This directory contains the governed agent runtime that coordinates three
domains — workshop, business, and home — behind a safety envelope, an
orchestration graph, an adaptive learning layer, a Z-state autonomy gate, a
reliability health monitor, and a memory-consolidation layer. Business,
workshop, and home domain state is versioned and durable when the runtime is
created with Jarvis' JSON or Convex persistence provider.

## What it is

- A self-contained subsystem under the `src/agent/` namespace. It does not
  bypass the maintained task/reminder runtime or governed tool-action boundary.
- Fully typed and covered by the agent tests. `npm run agent:check` and
  `npm run agent:repl` create the system with the configured JSON or Convex
  provider, so domain mutations survive process restart. Tests can inject the
  explicit in-memory store when isolation is required.

## What it is NOT

- Adaptive learning and memory remain session-scoped unless separately wired to
  a durable store. Domain state is persisted through the shared versioned
  `agentDomainState` record.
- **Not real-world safety.** The `SafetyEnvelope` enforces software consistency
  rules (e.g. "tool use requires a toolId"). It is not PPE, hazard, or
  machine-safety enforcement and must never be relied on as such.
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
2. **Durable domain state** — `domainState.ts`: one shared, versioned store with serialized read-modify-write updates for business, workshop, and home.\n3. **Intent mapping** — `conversationService.ts`: canonical job intents with synonym phrasings (`start`/`kick off`/`begin`, `prepare`/`prep`/`set up`, `complete`/`finish`/`close`) plus `jobId` extraction.
4. **Orchestration graph** — `graph.ts`: config-driven intent → weighted nodes (`defaultGraphConfig`).
5. **Adaptive layer** — `learningEngine.ts` (per-intent success stats) and `predictionEngine.ts` (lifecycle next-intent prediction).
6. **Autonomy layer** — `workflowGenerator.ts` / `ruleEvolution.ts`: data-driven, advisory proposals that are never auto-applied.
7. **Reliability** — `healthMonitor.ts`: metric-derived status that gates autonomy (critical health blocks activation).
8. **Memory** — `memoryConsolidator.ts` / `memoryManager.ts`: bounded short-term pruning, orphan-free lineage, usable profiles.
9. **Z-state** — `zState.ts`: activates only when safety is ok, reliability is healthy, and enough history exists.
10. **Validation suite** — `validationSuite.ts`: per-subsystem self-checks.
11. **Full system test** — `systemCheck.ts` + `autonomyDemo.ts`: end-to-end scenario and governed-autonomy demonstration, exercised by `npm run agent:check` and `tests/agentSystem.test.ts` / `tests/agentMemory.test.ts`.
