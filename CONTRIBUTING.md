# Contributing to Jarvis

## Copilot Workflow

All changes to Jarvis follow a deterministic multi-agent pipeline:

1. Operator defines the slice.
2. Claude performs reasoning and edge-case exploration.
3. ChatGPT produces the implementation (CLI, Convex, tests, OpenAPI, runbooks).
4. Copilot enforces contracts using [/docs/copilot/copilot-review-template.md](/docs/copilot/copilot-review-template.md).
5. Operator runs checks and smoke tests.
6. Commit only after all gates pass.

Copilot is responsible for:

- CLI contract enforcement
- Reminder invariants (dueRaw, flag correctness)
- JSON/Convex semantic alignment
- Backup/restore correctness
- HTTP/MCP operator contract
- Documentation alignment with owner goals

Copilot does not modify code directly.

Jarvis follows the principle:
"Keep it boring first. Boring is what works."

See [/docs/copilot/](/docs/copilot/) for the full collaboration contract, owner goals, review checklist, and workflow.
