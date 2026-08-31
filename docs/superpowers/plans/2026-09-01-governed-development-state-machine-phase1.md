# Governed Development State Machine Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove Jarvis governance end-to-end for one development mission: validated GitHub issue -> bounded worker execution -> verification/review -> merge evidence -> ΩΣ completion.

**Architecture:** `JARVIS_TRANSITIONS.yaml` is the machine-readable source of truth for legal transitions. Human-readable transition documentation and TypeScript implementation must be mechanically checked against it. Models/workers may request transitions, but the trusted commit boundary authenticates authority and atomically appends events/advances projections; completion remains exclusively ΩΣ-owned.

**Tech Stack:** TypeScript 6, Node 24, js-yaml, existing Jarvis test runner (`node --import tsx --test`), Convex transactions/OCC for durable commit implementation.

**Spec:** `JARVIS_ARCHITECTURE.md`, `JARVIS_CONSTITUTION.md`, `JARVIS_TRANSITIONS.yaml`, `JARVIS_TRANSITIONS.md`, `JARVIS_EVENTS.md`, `JARVIS_ROADMAP.yaml`

## Global Constraints

- Preserve existing ΩΣ completion authority; do not create a second completion path.
- Preserve existing ToolAction execution/claim/receipt/reconciliation authority boundaries.
- LLM/model output may propose but never authorise or commit authoritative state.
- Stable transition IDs are long-lived API identifiers.
- `REJECTED`, `FAILED`, and `INDETERMINATE` are distinct outcomes.
- Rejected transition attempts emit durable audit events without changing governed state.
- Authoritative transition/event history is append-only; materialised projections must remain derivable and auditable.
- Event schema versions and reducer versions are independent and have an explicit compatibility map.
- Commit-time authority is authenticated/enforced inside the trusted commit path, never trusted from caller-supplied role fields.
- `INDETERMINATE` resolves only through reconciliation/evidence; elapsed time alone cannot convert it to `FAILED`.
- Phase 1 covers the Development domain only; do not generalise prematurely.

---

### Task 1: Canonical machine transition source and governance contract

**Files:**
- Create: `JARVIS_TRANSITIONS.yaml`
- Create: `JARVIS_ARCHITECTURE.md`
- Create: `JARVIS_CONSTITUTION.md`
- Create: `JARVIS_TRANSITIONS.md`
- Create: `JARVIS_EVENTS.md`
- Create: `JARVIS_ROADMAP.yaml`

**Interfaces:**
- Consumes: existing ΩΣ and ToolAction architecture.
- Produces: stable invariant IDs, transition IDs, side-effect classes, authority roles, event envelope, Phase 1 development lifecycle.

- [x] Create `JARVIS_TRANSITIONS.yaml` first as machine source of truth.
- [x] Write the human governance artefacts around that registry.
- [ ] Add automated alignment test: YAML transition IDs/from/to/side-effect/committer must match the TypeScript registry; Markdown must reference every YAML transition ID exactly once as a transition section.
- [ ] Confirm `MERGED -> COMPLETE` is ΩΣ-only.
- [ ] Confirm operation retry semantics do not mutate state transitions blindly.

### Task 2: Development transition kernel — RED

**Files:**
- Create: `typescript/tests/developmentStateMachine.test.ts`
- Create later: `typescript/src/development/stateMachine.ts`

**Interfaces:**
- Produces expected public API: `DEVELOPMENT_TRANSITIONS`, `evaluateDevelopmentTransition`, `DevelopmentState`, `TransitionRequest`.

- [x] Write initial failing tests for legal transition lookup, illegal-transition rejection, stale lease rejection, authority-envelope rejection, approval requirements, and ΩΣ-only completion.
- [ ] Add failing test proving a rejected transition produces a durable rejection-event description and no projection mutation.
- [ ] Add failing test proving caller-supplied `actorType: omega` is insufficient without trusted ΩΣ commit capability.
- [ ] Add failing test proving two workers racing from the same projection version cannot both commit conflicting transitions.
- [ ] Add failing test proving a duplicated event ID is idempotent on projection replay.
- [ ] Add failing test proving unsupported event-schema/reducer compatibility fails closed.
- [ ] Confirm the RED failure is specifically due to the missing implementation rather than malformed tests.

### Task 3: Development transition kernel — GREEN

**Files:**
- Create: `typescript/src/development/stateMachine.ts`
- Create: `typescript/src/development/transitionRegistry.ts`

**Interfaces:**
- `evaluateDevelopmentTransition(request): TransitionEvaluation`
- Runtime transition registry is loaded/generated from `JARVIS_TRANSITIONS.yaml` and validated at startup/test time.

- [ ] Implement the minimum deterministic transition definitions required by the RED tests.
- [ ] Encode side-effect class, reversibility, approval rule, retry target, authoritative committer, and failure classification.
- [ ] Do not treat role strings as credentials; evaluation accepts trusted authority context separately.
- [ ] Run targeted tests and confirm GREEN.

### Task 4: Trusted commit boundary, events, reducers — RED then GREEN

**Files:**
- Create: `typescript/src/development/events.ts`
- Create: `typescript/src/development/reducer.ts`
- Create/modify tests under `typescript/tests/developmentStateMachine.test.ts` or a focused reducer test file.

**Interfaces:**
- `JarvisEvent` includes `eventSchemaVersion`, `correlationId`, optional `causationId`, actor separation, transition ID, evidence IDs, and reducer version.
- `applyDevelopmentEvent(projection, event)` is deterministic/idempotent.
- commit API accepts expected projection version for optimistic concurrency.

- [ ] RED: event-envelope/schema compatibility validation.
- [ ] RED: duplicate event replay produces no second projection change.
- [ ] RED: conflicting expected-version commits cannot both win.
- [ ] RED: rejected requests create audit events but no domain-state transition.
- [ ] GREEN: implement minimal event validator/reducer/commit contract.
- [ ] Confirm projection records latest event ID, projection version, reducer version.

### Task 5: Reconciliation semantics for indeterminate operations

**Files:**
- Extend focused Development tests/implementation only.

- [ ] RED: an indeterminate merge attempt cannot transition directly to MERGED or FAILED.
- [ ] RED: reconciliation requires authoritative external observation before resolving ambiguous merge outcome.
- [ ] RED: timeout alone leaves reconciliation open.
- [ ] GREEN: implement the minimum reconciliation state/evaluation contract.

### Task 6: PR evidence package

**Files:**
- PR description/evidence only unless CI reveals a required repository change.

- [ ] Record test/type/lint evidence.
- [ ] Record YAML/Markdown/TypeScript alignment result.
- [ ] Record race/idempotency/schema-compatibility stress results.
- [ ] Record authority-boundary checks, including trusted ΩΣ identity.
- [ ] Record known non-goals and remaining Phase 1 work.
- [ ] Keep PR unmerged if any constitutional or completion-authority check is unresolved.
