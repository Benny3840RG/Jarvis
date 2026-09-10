# Jarvis production completion ledger

## Development Live Work and restore marker hardening — 2026-09-11

- BASE SHA: `fae9949fc1f9d1ce15729608384a6d32ec40b8cb` (fetched origin/main).
- GOAL: Finish the existing read model and dashboard; preserve completion authority.
- CURRENT TRUTH: An uncommitted draft existed. It confused idle/unavailable,
  selected terminal or arbitrary current missions, reused stale attempt progress,
  inferred unbound ΩΣ identity and did not evaluate current completion inputs.
- FILES CHANGED: Development read model/factory; existing Convex development query
  and shared ΩΣ derivation; HTTP/OpenAPI/MCP/dashboard wiring; corresponding tests.
  Restore marker validation and its regressions are a separate security fix.
- TESTS: 35 focused Node tests pass (domain, adapter, HTTP, actual widget functions).
  Eleven focused Convex query tests pass; 18 ΩΣ integrity/projection tests pass.
  The shared-checkout full gate passed typecheck, static/OpenAPI/hygiene, 1,412 Node tests and 249 Convex tests. An independent worktree verification remains required after the concurrency-safe transfer.
- CI: Base main TypeScript run `34476444437` and CodeQL `34476443315` passed.
  Candidate CI not yet run.
- RUNTIME PROOF: Actual `npm run start:mcp` subprocess against an isolated JSON
  HTTP runtime returned the exact unavailable response from both
  `get_development_live_work` and `show_jarvis_dashboard.structuredContent.liveWork`.
  Active/repair/indeterminate/merged/ready/complete renderer scenarios are local
  synthetic tests, not external production commissioning.
- EXTERNAL PROOF: Development Convex `dev:outgoing-ram-798` accepted the query after fixing a Node-only import in its bundle. The actual query returned available/idle, and both real MCP tools returned that same live read. No mission or customer records were mutated.
- SECURITY: Bounded, validated projection strips unknown fields and lease secrets.
  Explicit ΩΣ binding only; completion still commits through existing ΩΣ transition.
  Restore regression reproduced unrelated-file deletion via a forged planned-file
  marker; exact archive-derived allowlist and marker matching now reject it.
- REVIEW: Independent review found inferred ΩΣ binding, stale progress after repair,
  and full-history event scanning. Regression repairs completed.
- PR: #502, initial head `5c36dd50640ce5042b0145416b4336f8f25403ee`. Merge pending.
- CI REPAIR: Automated review preparation exceeded its complete-file context bound and skipped the reviewer. This is being repaired; the failed review gate is not bypassed.
- BACKLOG/MATRIX UPDATE: ROADMAP archive status corrected against #492/#501.
- RESIDUAL RISK: ΩΣ residual uncertainty is not persisted by existing authority;
  query reports `residual-uncertainty-not-recorded` instead of inventing zero.
  Terminal missions are not selected as current work. Synthetic COMPLETE rendering
  is not proof that a real mission completed.
- WORKSPACE: Another owner session was confirmed active in `Jarvis-live`; this session moved all work to `Jarvis-production-20260911` without reverting the shared checkout.
- NEXT ACTION: Repair bounded review preparation; verify the updated exact candidate and land safely,
  verify main, then disposition stale PRs and complete remaining archive groups.

## Current external gates (not a claim that engineering is exhausted)

### Open engineering gap — Live ΩΣ readiness assessment

- Slice: Live Work commissioning.
- Missing: Durable residual uncertainty input from the existing completion path.
- Why required: `evaluateOmegaCompletion` needs this input; models/HUD cannot invent it.
- Exact operator action: No operator request yet; reconcile the existing assessment
  contract before designing any additive persistence change.
- Evidence that will clear it: Governed durable assessment usable by the same policy.
- Dependent work: Real pre-completion ΩΣ READY proof.
- Independent work still available: Read model hardening, all other production slices.

### Commissioning evidence still to inspect

- Slice: Outlook, Sentry, PostHog, OIDC/gateway, durable orchestration, production.
- Missing: Current-release live provider evidence and scoped production authority.
- Why required: Offline tests and old telemetry cannot commission external effects.
- Exact operator action: To be narrowed by provider inspection; tracked issues
  #293/#294/#297, #302, #303, #306, #307 and #324 remain evidence work.
- Evidence that will clear it: Current-release receipts, identity denial/allow tests,
  alert/telemetry reads, recovery/rollback drills, exact-release production approval.
- Dependent work: Production release and production-safe smoke verification.
- Independent work still available: Open PR repairs, archive S4–S6, local security fixes.
