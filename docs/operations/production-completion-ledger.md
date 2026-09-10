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
  The isolated exact candidate `bb95e45a4539196aaaba3887bd2970657fc6dd07` passed typecheck, static/OpenAPI/hygiene, 1,415 Node tests and 250 Convex tests.
- CI: Base main TypeScript run `34476444437` and CodeQL `34476443315` passed.
  Candidate TypeScript/build run `34539056082`, PR evidence `34539056044`, and CodeQL runs `34539047336`/`34539047360` passed. Automated review run `34539248627` is blocked by context preparation; it is not a passing gate.
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
- PR: #502, verified implementation head `bb95e45a4539196aaaba3887bd2970657fc6dd07`. Merge pending.
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

## Existing PR reconciliation — 2026-09-11

- PR #485: preserved current-main Hono 4.13.7 instead of its vulnerable downgrade;
  raised js-yaml minimum and corrected Claude mention triggers. Independent review
  of the pinned action found removal of OIDC permission alone broke authentication.
  Explicit `github.token` now preserves the job's scoped permissions. Regression
  reproduced, 43 automation/evidence tests pass, and exact `7eabd92` full check
  passes (1,375 Node / 237 Convex). Published to existing branch; CI/review pending.
- PR #486: corrected configured-versus-commissioned status and current architecture
  descriptions. The reader reports missing evidence access without claiming that
  no real delivery/approval exists. Exact `92be4d0` full check passes (1,376 Node /
  237 Convex). Published to existing branch; CI/review pending.
- PR #487: isolated review reproduced slow credential redaction on percent-heavy
  input. Bounded deterministic scanner fails closed on exhausted work; it preserves
  normal unaffected text. Integrated `a1d96f8` passes full check (1,388 Node /
  237 Convex). Not yet published or merged.
- PR #482: reconciliation underway in its own worktree. Malformed OAuth callback
  reproduced an uncaught URL error; it now returns 400 while successful and denied
  mailbox tests still pass. Provisioning retry behavior remains under review.
- No production deployment, mailbox consent, customer send or owner approval is
  implied by these offline repairs. Other session's shared checkout is untouched.

## Bounded independent review prerequisite — PR #503

- BASE SHA: `fae9949fc1f9d1ce15729608384a6d32ec40b8cb`.
- GOAL: Repair complete-file review context preparation without skipping coverage.
- CURRENT TRUTH: PR #502 exceeded the existing 160 KiB aggregate context limit;
  the reviewer never ran and the existing publisher correctly blocked it.
- FILES CHANGED: Existing automation collector/controller/workflow and tests;
  bounded UTF-8 segment manifest/aggregation helper.
- TESTS: 153 automation tests pass (six existing local socket-fixture skips);
  full gate passes with 1,375 Node / 237 Convex and all static checks.
- CI: TypeScript/build `34540369685`, evidence `34540369591`, CodeQL
  `34540367442` and `34540367824` passed on exact head `55c1b954`.
- REVIEW: Independent lead review plus old trusted reviewer run `34540569749`
  passed. No unresolved blocking threads; no review or permission gate bypassed.
- PR: #503. MERGE SHA: `344554b98b818440e0484a8b336a9c3cb498e5e6`.
  Fetched main tree exactly equals the reviewed head; main CI verification pending.
- SECURITY: Existing owner/approval/completion authority unchanged. Every bounded
  segment and exact run/attempt binding is required; essential missing-context
  requests block aggregation. No claim of holistic context or approval from a model.
- RUNTIME/EXTERNAL PROOF: Bootstrap passed the previous workflow. Actual segmented
  workflow commissioning against PR #502 remains required after integration.
- BACKLOG UPDATE: This prerequisite clears the preparation implementation defect;
  it does not yet establish Live Work review success or production completion.
- NEXT ACTION: Verify main CI, integrate current main and exercise segmented review.
