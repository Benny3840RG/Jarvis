# Jarvis Owner Goals

## Core Deliverables

- Durable tasks and reminders with explicit commands.
- JSON and Convex persistence with identical semantics.
- Backup and restore correctness with versioned archives.
- Reliable smoke tests for Convex development deployments.
- HTTP adapter with liveness, authenticated help, and operator status.
- MCP preview for controlled ChatGPT integration.

## Non-Goals

- Multi-user authentication.
- Public SaaS behaviour.
- Natural-language fuzzy commands.
- Invented timestamps or inferred due dates.

## Philosophy

"Keep it boring first. Boring is what works."

## Operator Expectations

- Deterministic behaviour.
- Explicit flags.
- No silent mutations.
- Clear error messages.
- Durable, predictable state transitions.

## Collaboration Model

- Claude: architecture, reasoning, concurrency, failure modes.
- ChatGPT: TypeScript/Convex implementation, tests, OpenAPI updates.
- Copilot: invariants, contracts, review, documentation, operator UX.
