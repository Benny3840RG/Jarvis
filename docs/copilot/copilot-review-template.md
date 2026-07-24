# Copilot Review Checklist

## CLI Contract

- Commands remain explicit and non-fuzzy.
- Mutations require explicit flags; no implicit writes.
- Reminder `dueRaw` preserved exactly.
- `--due` and `--clear-due` never combined.
- Update flags validated in any order; unknown flags rejected.

## Persistence Providers

- JSON provider atomic write semantics preserved.
- `.lock` behaviour unchanged; no unsafe concurrency.
- Convex functions maintain single-user service-token model.
- No weakening of authentication or ownership boundaries.

## Backup / Restore

- Archives remain provider-neutral and versioned.
- Restore refuses non-empty targets.
- Record-ID remapping preserved.
- Temporary restore directories cleaned correctly.

## HTTP / MCP

- Operator API contract unchanged.
- No accidental exposure of service tokens.
- MCP preview remains stateless and scoped.

## Tests & Checks

- `npm run check` passes (TS, ESLint, Prettier, tests).
- Coverage meaningful for new logic.
- Smoke test remains valid for dev deployments only.

## Documentation

- Runbooks remain accurate.
- No drift from owner goals.
- No contradictions with architecture docs.
