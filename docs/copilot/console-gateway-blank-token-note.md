# Console gateway blank-token hardening review note

This note supports PR review only. It records why the change is intentionally small.

- Scope is limited to Console 01 gateway configuration classification.
- A blank or whitespace-only `CONSOLE_GATEWAY_TOKEN` is treated as missing configuration.
- Non-blank token matching remains exact and constant-time through the existing digest comparison.
- No MCP tool catalogue, Convex bridge, HUD layout, quote action, ToolAction, or reconciliation code is changed.
