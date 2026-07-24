# Copilot Collaboration Workflow

This file defines the structured workflow for collaborating with Copilot, Claude, and ChatGPT.

## 1. Define the Slice (Operator)

Describe the smallest meaningful change:

- One command
- One flag
- One provider behaviour
- One HTTP endpoint
- One reminder parsing rule

## 2. Claude (Reasoning)

Claude explores:

- Edge cases
- Concurrency
- Failure modes
- Operator expectations
- Contract implications

Output: a refined problem statement with constraints.

## 3. ChatGPT (Implementation)

ChatGPT produces:

- TypeScript CLI changes
- Convex functions
- Tests (JSON + Convex)
- OpenAPI updates
- Runbook adjustments

Output: a proposed patch or PR-ready diff.

## 4. Copilot (Contract Enforcement)

Copilot checks:

- CLI explicitness
- Reminder parsing invariants
- JSON/Convex provider semantics
- Backup/restore correctness
- HTTP/MCP contract alignment
- Documentation consistency

Output: a review summary using `copilot-review-template.md`.

## 5. Operator (Execution)

Run:

- `npm run check`
- `npm run test:coverage`
- Convex smoke test (dev deployments only)

Commit only after all gates pass.

## 6. Repeat

Jarvis evolves through small, boring, durable slices.
