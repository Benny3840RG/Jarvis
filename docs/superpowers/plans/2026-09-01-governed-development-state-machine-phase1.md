# Governed Development State Machine Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove Jarvis governance end-to-end for one development mission: validated GitHub issue -> bounded worker execution -> verification/review -> merge evidence -> ΩΣ completion.

**Architecture:** Add canonical governance specs, then implement a small deterministic development transition kernel in TypeScript. The kernel owns legal transition definitions and admissibility checks; models/workers may request transitions but cannot authorise or commit transitions outside the declared authority matrix. Completion remains exclusively ΩΣ-owned.

**Tech Stack:** TypeScript 6, Node 24, existing Jarvis test runner (`node --import tsx --test`), Convex-compatible domain types.

**Spec:** `JARVIS_ARCHITECTURE.md`, `JARVIS_CONSTITUTION.md`, `JARVIS_TRANSITIONS.md`, `JARVIS_EVENTS.md`, `JARVIS_ROADMAP.yaml`

## Global Constraints

- Preserve existing ΩΣ completion authority; do not create a second completion path.
- Preserve existing ToolAction execution/claim/receipt/reconciliation authority boundaries.
- LLM/model output may propose but never authorise or commit authoritative state.
- Stable transition IDs are long-lived API identifiers.
- `REJECTED`, `FAILED`, and `INDETERMINATE` are distinct outcomes.
- Authoritative transition/event history is append-only; materialised projections must remain derivable and auditable.
- Phase 1 covers the Development domain only; do not generalise prematurely.

---

### Task 1: Canonical governance contract

**Files:**
- Create: `JARVIS_ARCHITECTURE.md`
- Create: `JARVIS_CONSTITUTION.md`
- Create: `JARVIS_TRANSITIONS.md`
- Create: `JARVIS_EVENTS.md`
- Create: `JARVIS_ROADMAP.yaml`

**Interfaces:**
- Consumes: existing ΩΣ and ToolAction architecture.
- Produces: stable invariant IDs, transition IDs, event envelope, Phase 1 development lifecycle.

- [ ] Write the five canonical artefacts.
- [ ] Cross-check every Phase 1 transition against constitutional invariants.
- [ ] Confirm `MERGED -> COMPLETE` is ΩΣ-only.
- [ ] Confirm operation retry semantics do not mutate state transitions blindly.

### Task 2: Development transition kernel — RED

**Files:**
- Create: `typescript/tests/developmentStateMachine.test.ts`
- Create later: `typescript/src/development/stateMachine.ts`

**Interfaces:**
- Produces expected public API: `DEVELOPMENT_TRANSITIONS`, `evaluateDevelopmentTransition`, `DevelopmentState`, `TransitionRequest`.

- [ ] Write failing tests proving legal transition lookup, illegal-transition rejection, stale lease rejection, authority-envelope rejection, approval requirements, and ΩΣ-only completion.
- [ ] Push tests without production implementation.
- [ ] Confirm CI/test failure is specifically caused by the missing state-machine module.

### Task 3: Development transition kernel — GREEN

**Files:**
- Create: `typescript/src/development/stateMachine.ts`

**Interfaces:**
- `evaluateDevelopmentTransition(request): TransitionEvaluation`
- Transition definitions reference stable IDs from `JARVIS_TRANSITIONS.md`.

- [ ] Implement the minimum deterministic transition definitions required by the tests.
- [ ] Encode side-effect class, reversibility, approval rule, retry policy, authoritative committer, and failure classification.
- [ ] Run CI and confirm the new tests pass.

### Task 4: Event and projection contract tests

**Files:**
- Modify: `typescript/tests/developmentStateMachine.test.ts`
- Create if required: `typescript/src/development/events.ts`

**Interfaces:**
- `JarvisEvent` includes `correlationId`, optional `causationId`, actor separation, transition ID, evidence IDs, reducer version.

- [ ] Add failing tests for event-envelope validation and deterministic projection input requirements.
- [ ] Implement only the validation/types required to make them pass.
- [ ] Confirm events cannot claim authority absent from the transition evaluation.

### Task 5: PR evidence package

**Files:**
- Modify: PR description only unless CI reveals a required repository change.

- [ ] Record test/type/lint evidence.
- [ ] Record architecture invariants checked.
- [ ] Record known non-goals and remaining Phase 1 work.
- [ ] Keep PR unmerged if any constitutional or completion-authority check is unresolved.
