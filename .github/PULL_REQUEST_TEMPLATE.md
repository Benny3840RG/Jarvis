# PR Summary

Describe the slice:

- Command / flag / provider / endpoint / reminder rule

# Implementation (ChatGPT)

Describe changes:

- CLI
- Convex
- Tests
- OpenAPI
- Runbooks

# Reasoning (Claude)

Paste Claude's refined problem statement.

# Copilot Review

Use [/docs/copilot/copilot-review-template.md](/docs/copilot/copilot-review-template.md).
Replace every `[...]` with a concrete finding or `N/A — <reason>` (reasons must be specific).
Agents that cannot edit the PR description may instead put the same filled section in
`.github/pull_request_update` — the Copilot Review Check accepts that file as a fallback.

- CLI Contract: [...]
- Persistence Providers: [...]
- Backup / Restore: [...]
- HTTP / MCP: [...]
- Tests & Checks: [...]
- Documentation: [...]

# Operator Verification

- npm run check
- npm run test:coverage
- Convex smoke test (dev only)
