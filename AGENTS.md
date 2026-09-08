cat > AGENTS.md << 'EOF'
# Jarvis – Codex Agent Instructions

You are an execution-focused engineering agent for the Jarvis project.

## Project truth

- Repository: https://github.com/Benny3840/Jarvis
- Maintained app: TypeScript CLI in `typescript/`.
- Runtime: Node.js 24 (`typescript/.nvmrc`).
- Persistence: JSON (default) and Convex (opt-in, service-token auth).
- Operator API contract: `typescript/openapi/jarvis.openapi.json` (OpenAPI 3.1).

Key commands (run from `typescript/`):

- `npm ci`
- `npm run check` = tsc + ESLint + Prettier + tests
- `npm run openapi:lint` = OpenAPI spec lint (must be zero warnings)
- `npm run smoke:convex` = Convex smoke test (dev deployments only)
- `npm run backup -- export|verify|restore`

Docs:

- Architecture: `typescript/docs/architecture/`
- Operators: `typescript/docs/operators/`
- Runbooks: `docs/operations/`

## Mission

- Produce concrete, test-gated progress on Jarvis every session.
- Leave the codebase more reliable, better tested, and clearer than you found it.
- Work incrementally on the existing codebase. **Do NOT restart Jarvis from scratch.**

## Hard rules

1. **No architecture monologues**  
   - Keep reasoning brief and tied to specific files, functions, or tests.  
   - Prefer code, tests, and docs over prose.

2. **Test-first, always**  
   - For any non-trivial change: write/update tests first, then implement minimal code to pass them.  
   - Every session must end with `npm run check` passing in `typescript/`.

3. **Contract-first for APIs**  
   - If a change affects HTTP/MCP endpoints or operator-visible behavior:  
     - Update `typescript/openapi/jarvis.openapi.json` first.  
     - Run `npm run openapi:lint` and ensure zero warnings.  
     - Ensure implementation matches the updated spec.

4. **Small, shippable steps**  
   - Work in small commits that each compile cleanly, pass tests, and do not break existing behavior.  
   - Break large tasks into sub-tasks and complete them one by one.

5. **No silent drift**  
   - If you change behavior, update tests and relevant docs.  
   - If you add new state or fields, ensure backup export/verify/restore still work and old backups remain readable.

6. **Call out blockers explicitly**  
   - If blocked by missing credentials, unclear requirements, or contradictions between docs/tests/code:  
     - State the blocker in one short paragraph.  
     - Propose 1–3 concrete options to resolve it.  
     - Wait for my choice before proceeding.

## Session protocol

At the start of each session:

1. **Orient (brief)**  
   - Scan:  
     - `typescript/docs/ROADMAP.md` (create if missing).  
     - Open issues, TODOs, recent commits, failing tests/lint.  
   - Identify 1–3 high-impact tasks that improve:  
     - Core abstractions (providers, actions, workflows).  
     - Operator API contract and tests.  
     - Backup/verify/restore reliability.  
     - Test coverage and developer experience.

2. **Pick one task**  
   - Choose the single most important task.  
   - Break it into 2–5 small, testable steps.

3. **Execute step-by-step**  
   For each step:  
   - Write or update tests.  
   - Implement minimal code to pass tests.  
   - Run:  
     - `npm run check` in `typescript/`.  
     - `npm run openapi:lint` if the OpenAPI spec changed.  
     - `npm run smoke:convex` if Convex behavior changed (against a `dev:` deployment).  
   - Commit with a clear message.

4. **Record progress**  
   - Update `typescript/docs/ROADMAP.md` with:  
     - What you completed.  
     - Important decisions or trade-offs.  
     - Next 2–3 tasks.  
   - If you added a new pattern/abstraction, add a short note in `typescript/docs/` explaining purpose, fit, and example usage.

5. **Stop cleanly**  
   - End each session with:  
     - All tests green.  
     - `npm run check` passing.  
     - A short bullet list of what changed and what’s next.

## Ideal build sequence (do not skip)

Work through these phases in order, without skipping ahead. Do not rewrite existing working code unless it directly unblocks progress or fixes correctness/safety.

### Phase 0 – Orientation and baseline

- Scan repo: README, `typescript/` structure, `package.json`, `tsconfig.json`, docs, OpenAPI spec, recent commits.
- Ensure baseline health:  
  - `npm ci` in `typescript/`.  
  - `npm run check` passing; fix existing failures.  
  - `npm run openapi:lint` passing with zero warnings.  
  - If Convex is configured, `npm run smoke:convex` against a `dev:` deployment.
- Create/update `typescript/docs/ROADMAP.md`:  
  - 5–10 bullet summary of current state.  
  - Known gaps, flaky areas, TODOs.  
  - Ordered next tasks aligned with phases below.

Commit: “Phase 0: baseline health and roadmap”.

### Phase 1 – Core data model and invariants

- Inspect current state shapes for tasks, reminders, assistant state (JSON and Convex).
- Enforce strict TypeScript types and runtime validation (Zod or equivalent).
- Add tests for:  
  - Task CRUD and invariants (no duplicate IDs, cannot re-complete, etc.).  
  - Reminder CRUD and due parsing/normalization rules.  
  - Assistant state operations.
- Ensure JSON and Convex providers respect the same invariants.

### Phase 2 – Persistence providers (JSON and Convex)

- Define/clarify provider interface (common operations, concurrency, atomicity).
- Harden JSON provider: atomic writes, `.lock` concurrency, `.corrupt-*` handling; add tests.
- Harden Convex provider: service-token auth, owner-scoped records, dev-only guard; add tests.
- Unify behavior so both providers pass the same test suite where possible.

### Phase 3 – CLI commands and user-facing behavior

- Audit existing commands (`task *`, `reminder *`, etc.) and align with provider operations.
- Strengthen command semantics: strict flag parsing, clear errors, no silent failures.
- Add/expand CLI tests (happy paths, invalid input, edge cases) against both providers or a mock layer.
- Ensure README and operator docs reflect actual CLI behavior.

### Phase 4 – Operator API contract (OpenAPI) and adapters

- Audit `typescript/openapi/jarvis.openapi.json`; ensure it covers liveness, auth, status, tasks, reminders, backup ops.
- Fix schema issues; ensure `npm run openapi:lint` passes with zero warnings.
- For gaps between spec and implementation: update spec first, then implementation.
- Harden HTTP adapter (auth, structured errors) and add basic request/response + auth-failure tests.
- Align MCP/ChatGPT preview adapter with the spec; add minimal endpoint tests.

### Phase 5 – Backup, verify, restore

- Audit current backup format (state, tasks, reminders, source IDs/timestamps, normalized due data, versioning).
- Strengthen export (deterministic, stable, private permissions, no extra sensitive data).
- Strengthen verify (restore to temp storage, validate all fields, check invariants, clean up).
- Strengthen restore (empty-target only, `--confirm-empty-target`, rollback on failure, ID remapping).
- Add tests for valid/corrupt archives, success/failure flows.

### Phase 6 – Observability, safety, and governance

- Ensure structured logging (levels, context) for key operations.
- Add safety guards for destructive operations (restore, bulk mutations): explicit, well-gated, logged.
- Add basic rate/budget guards if applicable.
- Add tests for auth failures and safety guards; document operational expectations in operator docs.

### Phase 7 – Hardening, polish, and automation

- Fix remaining TODOs affecting correctness/safety; remove dead code; clarify confusing modules.
- Improve developer experience: actionable errors, consistent commands, accurate docs, example workflows.
- Ensure CI covers `npm run check`, `npm run openapi:lint`, and Convex smoke test (dev-only).

## What I want from you in this chat

- Treat my messages as high-level direction, not line-by-line instructions.
- Take ownership of choosing the next concrete task from the roadmap, issues, or code gaps.
- Produce: failing tests first, then code that makes them pass, then minimal docs updates.
- Never leave the repo in a broken state.

If I say “build X” or “fix Y”:

- Translate that into 2–5 concrete steps.
- Execute them with tests and checks.
- Report back with what changed (files, functions, tests) and remaining gaps/follow-ups.

If I ask whether you’re just taking me for a ride:

- Stop and show:  
  - The last 5–10 concrete changes you made (files, tests, commands run).  
  - What’s next in the roadmap.  
  - One specific thing you will do in the next 15 minutes to move Jarvis forward.

Begin now with **Phase 0, step 1**.
EOF
