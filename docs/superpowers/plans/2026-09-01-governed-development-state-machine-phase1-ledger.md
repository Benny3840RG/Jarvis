# Governed Development State Machine Phase 1 — Working Ledger

This ledger is an audit aid. Canonical authority remains the machine-readable
contracts and durable Jarvis records; checklist state here grants no authority.

## Current task

Publish and verify the fail-closed evidence follow-up on a fresh branch from
`main`, after pull request #415 merged.

## Completed in this work sequence

| Area                                  | Classification | Result                                                                                                                                                                                                                       |
| ------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical transition/event contracts  | HARDEN         | One root `TRANSITIONS.yaml`, one root `EVENTS.yaml`, runtime alignment tests, unsupported schemas fail closed.                                                                                                               |
| Development transition kernel/reducer | NEW            | Justified domain projection only; deterministic, versioned, idempotent, and barred from committing `COMPLETE`.                                                                                                               |
| Convex Development boundary           | EXTEND         | Atomic event append + projection update, durable rejection audit, idempotency conflicts, causation checks, trusted server time.                                                                                              |
| Orchestration claims/leases           | HARDEN         | Existing lease lifecycle now issues monotonic fencing tokens and checks them on consequential writes.                                                                                                                        |
| Development-to-orchestration binding  | EXTEND         | New subjects bind immutably to an existing run/node/repository/branch. Lease owner, opaque token, fence, expiry, scope and authority tier are loaded from existing durable orchestration records inside the commit mutation. |
| ToolAction merge execution            | EXTEND         | GitHub merge uses the existing approved single-use ToolAction path, pre-effect durable provider intent, exact reviewed SHA/effect binding and immutable audit history.                                                       |
| Reconciliation and resume             | EXTEND         | Existing reconciliation now distinguishes proven no-effect, permits only same-operation/same-effect resume, and reopens the existing orchestration operation with a newer fence.                                             |
| GitHub provider adapter               | NEW            | Justified provider-specific boundary only: issue/PR validation, merge call, provider observation and post-merge commit/check evidence. It creates no authority or truth store.                                               |
| Model routing and telemetry           | EXTEND         | Trusted registry, least-cost capable routing, bounded budgets/escalation, durable mission invocation events, aggregate latency/retry/waste metrics, and OpenAI/Gemini provider usage capture.                                |
| Omega completion                      | EXTEND         | Existing ΩΣ evidence/proof/mutation remains sole completion authority and atomically projects an explicitly bound Development mission to `COMPLETE`.                                                                         |
| Canonical hashing                     | HARDEN         | One canonical JSON encoder plus one isomorphic SHA-256 primitive now serves Phase 1 fingerprints without importing Node crypto into Convex mutations.                                                                        |
| Pull-request evidence gate            | HARDEN         | The former Copilot-named template check is now path-aware, requires companion tests for TypeScript source, obtains test truth from CI and treats every model review as advisory evidence rather than authority.              |

## Files changed in the current task

- `typescript/src/development/githubDevelopment.ts` and its provider tests.
- `typescript/convex/developmentState.ts` and its event-history tests.
- This working ledger.

## Verification evidence

- Full Convex suite after fail-closed audit repairs: 227 passed.
- Full Node suite after fail-closed audit repairs: 1,121 passed.
- Repository hygiene, application and Convex type checks: passed.
- ESLint, full-tree Prettier and OpenAPI validation: passed.

## Failures found and repaired

- Development commits trusted caller-provided lease fields without reading the
  orchestration claim. Repaired by binding the subject to the existing
  orchestration run/node and deriving admission inputs from those rows.
- Caller-provided mission/worker envelopes could influence commit evaluation.
  Repaired by deriving the scope from the immutable subject binding and the
  current orchestration authority tier.
- A test fixture initially used unsupported trigger source `webhook`; corrected
  to the existing canonical `http` source before evaluating the intended RED
  failures.
- Direct Git push was blocked because this environment has no HTTPS Git
  credential. Publication used the authenticated GitHub object/ref path with a
  non-forced fast-forward; the assembled remote tree was required to equal the
  locally verified tree before the branch ref moved.
- Convex-shared hashing initially imported Node-only crypto. Replaced with a
  standard-vector-tested isomorphic SHA-256 primitive.
- ΩΣ completion initially inferred its Development subject from ID equality.
  Repaired with an explicit immutable `omegaMissionId` binding.
- Same-ID single-use claims initially reopened without provider proof and two
  distributed resume callers could both approach the provider boundary.
  Resume now requires resolved `no-effect` evidence and the reconciliation
  mutation admits exactly one reopened provider attempt; the loser is blocked.
- Caller-supplied merge evidence could previously resemble success without a
  durable effect. The commit boundary now requires the approved ToolAction,
  execution claim, succeeded receipt and resolved provider reconciliation.
- The PR check was named as though it performed an independent Copilot review,
  but it only validated six manually written template lines. Repaired by
  renaming it `PR Evidence Check`, requiring only path-relevant findings and
  keeping test results in authoritative CI.
- GitHub check-run pagination could still return a partial passing set when the
  provider reported more than the bounded 20 pages or stopped early. Repaired
  by requiring the retrieved count to exactly match the provider total;
  incomplete or malformed evidence now reaches the existing post-merge
  observer as `INDETERMINATE` rather than proof of success.
- An adversarial follow-up found that raw count equality alone accepted repeated
  pages. The provider boundary now also requires a stable total and unique,
  valid GitHub check-run IDs, so duplicated pagination cannot conceal omitted
  failing evidence.
- The Development event-history query silently returned the first 1,000 events.
  Repaired by reusing the existing bounded-read guard, which detects the
  1,001st row and fails explicitly instead of presenting a truncated audit
  history as complete.

## Architectural decisions and assumptions

- No Development-specific claim or lease table was added. Existing
  `orchestrationRuns`/`orchestrationSteps` remain authoritative.
- The Development subject stores immutable mission bindings and a reproducible
  projection of the latest observed fence; the orchestration step remains the
  live lease authority.
- T2 or T3 orchestration authority is required to create a Phase 1 development
  subject. GitHub merge admission will still use the stricter existing
  ToolAction approval/execution path.
- Pre-binding Development rows are migration-compatible in schema but fail
  closed on lease-required transitions.
- Model resource figures without provider-confirmed billing remain estimates,
  never billing truth.
- Post-merge failed or pending CI is recorded as failed/inconclusive ΩΣ proof
  input and never triggers a completion request.
- Existing mutable receipt/reconciliation rows remain current projections;
  no-effect resolution and same-operation resume are preserved in immutable
  audit history rather than creating a second receipt authority.

## Blockers

- A real external mission run requires configured GitHub, Convex service and
  independent-proof approval credentials. No production credentials were
  requested or used during deterministic implementation/tests.
- No implementation blocker remains. Pull request #415 is merged, and the
  fail-closed audit repairs are isolated on a fresh `main`-based follow-up
  branch so the merged branch is not reused.

## Next task

Publish the follow-up branch, open its focused pull request, and drive checks
and independent review to an exact-head merge-authority decision.

## Publication evidence

- Remote branch: `agent/governed-dev-state-machine-phase1`.
- Pull request: #415, `feat: complete governed development mission Phase 1`.
- Published implementation commit: `57db34ab4491514cfa2cb9836761c22688c47511`.
- Verified local and remote tree:
  `11e34d77d14bbcf151704fb1e839431d492cdee0`.
- GitHub TypeScript checks: passed.
- GitHub Copilot Review template check: passed after replacing the inherited
  placeholder with concrete scope findings.
- Follow-up PR evidence policy tests: 29 passed across the path-aware evidence
  rules and autonomous-builder contract.

## Model/resource usage

The current coding runtime does not expose authoritative token/cost telemetry
to this ledger, so none is fabricated. Repository runtime adapters now record
provider-returned token/cache counts when available; costs remain explicitly
estimated unless provider billing marks them verified.

## Second independent review of the full diff (Claude, exhaustive pass)

A follow-up max-effort review covered the remainder of the diff not already
read in the earlier targeted pass (`developmentState.ts` in full,
`stateMachine.ts`, `transitionRegistry.ts`, `reducer.ts`, `events.ts`,
`omegaMissions.ts`, `convexDevelopmentOmegaGateway.ts`,
`developmentCompletion.ts`, `modelResourceGovernance.ts`, `toolActions.ts`,
`externalReconciliations.ts`, the reconciliation adapters, the non-fencing
`orchestrationState.ts` changes, and the alignment tests). One initial
candidate finding (`INDETERMINATE_TO_MERGED` accepting forged reconciliation
evidence) was re-traced and found to be a false positive -- `trustedMergeReason`
is gated on `args.to === "MERGED"` regardless of transition ID, so that path
is genuinely closed. Six real findings survived verification, all fixed:

- **Critical: `gates`/`evidenceRequired` were pure documentation, never
  enforced.** `evaluateDevelopmentTransition` never read those two registry
  fields; only `approval === "risk_dependent"` (merge only) triggered any
  real check. A caller with the shared service token could walk
  `VERIFYING -> REVIEW -> READY_TO_MERGE` -- the states a human reads as
  "verified" and "reviewed" -- with zero verification/review evidence,
  because nothing in the kernel or the Convex boundary checked for it
  (confirmed: no durable verification/review receipt concept exists
  anywhere in this codebase yet, and no test exercised these two
  transitions at all). Fixed by adding real `VerificationEvidence`/
  `ReviewEvidence` types and gates to the pure kernel (`stateMachine.ts`),
  keyed off each transition's own `evaluator` string
  (`deterministic_verification_success_gate`,
  `deterministic_review_findings_gate`, `deterministic_review_readiness_gate`)
  -- evidence _presence_ is itself required, not just checked when supplied
  (unlike `mergeEvidence`, which can rely on the Convex boundary's separate
  `trustedMergeReason` derivation; no such derivation exists yet for
  verification/review, so the kernel is the only line of defense).
  Threaded through `developmentState.ts`'s `commit` mutation args, request
  fingerprint, and validators, the same way `mergeEvidence`/
  `reconciliationEvidence` already are. This does not yet durably derive
  verification/review evidence from trusted rows the way merge evidence
  is derived from ToolAction/reconciliation records -- that is real,
  deferred pipeline work (Task 11's remaining execution/verification/review
  steps) -- but a caller can no longer skip it silently. 10 new pure-kernel
  tests (`developmentVerificationReviewGates.test.ts`) + 4 new Convex tests
  proving the real commit boundary enforces it too.
- **`omegaMissions.ts`: `residualUncertainty` remains caller-supplied, now
  with wider blast radius.** Every other completion input (criteria, proofs,
  contradictions, external effects) is derived from durable rows;
  `residualUncertainty` only ever gets a bounds check
  (`evaluateOmegaCompletion`: finite, `[0,1]`, `<= uncertaintyBudget`), and
  it predates this PR as an established part of the real ΩΣ contract. Since
  this PR wires `projectOmegaDevelopmentCompletion` into the same
  transition, a wrong value now also flips the linked Development subject
  to `COMPLETE`. Judged out of scope to redesign here -- it is pre-existing,
  reused ΩΣ authority, and it can only be reached after every other,
  fully row-derived completion check has already passed (a passing proof
  per criterion, independent proof for R3/R4, no unresolved contradictions,
  no unreconciled external effects) -- so it narrows an already-evidenced
  completion rather than substituting for evidence. Documented in place
  with an explicit code comment rather than silently left unremarked or
  redesigned unilaterally.
- **`convexDevelopmentOmegaGateway.ts`: `requestCompletion` broke idempotent
  retry.** Threw when a mission was already `complete` instead of no-oping,
  unlike every other commit/idempotency path in this PR. Fixed: returns
  early on `mission.state === "complete"`. 1 new test.
- **`developmentState.ts`: committed/rejected events never recorded
  `evidenceIds`**, including verified merges -- `commitContext` never
  populated it. Fixed: now includes the merge receipt key, verification/
  review receipt IDs, and reconciliation observation source when present on
  the request. 1 new assertion (existing verification-gate test extended).
- **`modelResourceGovernance.ts`: `deriveEscalationDisposition` trusted a
  caller-supplied `priorEscalationCount`** instead of deriving it from
  `aggregateModelUsage`, unlike `checkCognitiveBudget` in the same file.
  No caller existed yet, so unreachable in practice, but the API invited
  misuse. Fixed: now takes `usageSoFar` and derives the count internally,
  matching `checkCognitiveBudget`'s own signature. Existing test updated,
  1 new test added proving derivation instead of trust.
- **`developmentState.ts`: the merge risk-floor check didn't reject `NaN`**
  independently (`NaN < 4` is `false`). Investigating this revealed it is
  even less reachable than initially assessed: `canonicalJson` (shared by
  every fingerprint in this boundary) already refuses to hash a non-finite
  number, so re-fingerprinting the stored ToolAction fails closed _before_
  the risk check would ever run -- proven by a test that a NaN
  `effectiveRisk` throws during fixture construction itself, not merely at
  commit time. Added the explicit `Number.isFinite` check anyway as
  defense-in-depth for a path that already has an outer guard, in case the
  fingerprint check is ever reordered.

Two lower-severity, quality-only findings from the same review (a ~60-line
15-deep nested ternary computing merge rejection reasons in
`developmentState.ts`, and two independent DB reads awaited sequentially
instead of in parallel in the same file) were reported but not fixed --
maintainability/performance, not correctness or security, and out of scope
for this pass.

Full `npm run check` green after all fixes: 1,117 node tests (was 1,105),
224 Convex tests (was 219), type-check/lint/format/openapi all clean.

## Independent review of the GitHub mission slice (Claude, post-integration)

This branch is shared between two agents (ChatGPT and Claude); the commit
above ("complete governed GitHub mission slice") landed while Claude's own
session was mid-task. Before building further on it, Claude independently
re-ran the full check (matched the claimed 1,102 node / 219 Convex tests,
all green) and ran a high-effort code review targeted at the
security-sensitive paths: `githubDevelopment.ts`'s live merge client,
`toolExecutionFactory.ts`'s wiring, the Development/Omega/ToolAction/
orchestration authority boundaries, the new isomorphic SHA-256 primitive,
and the `TRANSITIONS.yaml`/`EVENTS.yaml` restructure.

Findings and disposition:

- **Fixed — `FetchGitHubDevelopmentClient.getCommitChecks` silently dropped
  check runs past the first 100.** `observeAndRequestCompletion` feeds this
  straight into ΩΣ completion evidence, so a commit with >100 check runs
  where a real failure lived past #100 would have been reported as fully
  passed — exactly the kind of truncated-evidence-as-proof gap this module's
  own docstring says it must not allow. Fixed by paginating on `total_count`
  (bounded to 20 pages). This class also had zero test coverage against
  mocked HTTP at all (only fakes of the interface were tested elsewhere), so
  the client's constructor was also given an injectable `fetch` option,
  mirroring the existing `MicrosoftGraphMessageStatusClient` pattern in this
  repo, and a new `typescript/tests/fetchGitHubDevelopmentClient.test.ts`
  proves pagination now works (RED-confirmed against the pre-fix code, then
  GREEN).
- **Fixed — duplicate `extractUsage` computation** in both
  `integrations/gemini/totalityReasoner.ts` and
  `integrations/openai/totalityReasoner.ts`: the same pure call was made
  twice (once in a condition, once in the object literal it gated) instead
  of once and reused, as the same class already does correctly for its
  other optional fields. No behavior change; pure simplification.
- **Reviewed, not changed — `orchestrationState.ts#requireActiveLease` and
  the newly-required `fencingToken` argument.** A step already `running`
  under pre-fencing-token code would fail this check after this PR deploys,
  since `leaseFencingToken` is undefined on it and can never match a
  caller-supplied token. This is a real deploy-time migration edge case, but
  it is self-healing, not a stuck state: `recoverExpiredStep` reclaims any
  `running` step once its `leaseExpiresAt` passes regardless of fencing
  state, so the effect is a bounded one-time delay (one lease TTL window) for
  whatever steps happen to be in flight at the moment this deploys, not
  starting today (no live Convex deployment exists yet in this Phase 1
  build). Writing migration-compat code for this now would be untestable in
  this sandbox and risks quietly weakening the fencing guarantee itself to
  accommodate a case that doesn't currently exist. Flagged here instead so
  it isn't lost: worth a deliberate look immediately before this PR is ever
  deployed live, not before.

Full check re-verified green after the two fixes above (node test count now
1,105 — the three new pagination tests — Convex unchanged at 219).

## Post-merge: wiring Console 01's HUD to the Development pipeline

PR #415 merged (`e60f62e`). Follow-on work, branched fresh from `main` per
the "already merged, don't stack on it" rule: the live HUD (Jarvis Console
01, a Manufact-deployed mcp-use app) had no visibility into Development
missions at all -- its `show-jarvis-console` widget showed tasks,
reminders, notes, and governed ToolActions, but nothing from the pipeline
this whole Phase 1 build exists to govern.

**Convex**: added `developmentSubjects.by_owner_and_updated_at` index and
`developmentState.listRecent` (owner-scoped, bounded, most-recently-updated
first) -- mirrors `toolActions.listRecent`'s existing bounded
recent-snapshot shape rather than real cursor pagination, since this is
operator inspection, not an exhaustive register. 2 new Convex tests.

**Console**: `index.ts` now calls `developmentState.listRecent` alongside
its existing task/reminder/note/tool-action reads, maps rows into a new
read-only `developmentMissions` field, and renders them in a new
"DEVELOPMENT MISSIONS" HUD panel (`widget.tsx`/`types.ts`/`phase23.css`),
styled exactly like the existing read-only governed-actions panel. Console
01 still exposes no way to advance, approve, or commit a Development
transition through the HUD -- inspection only, consistent with its
existing stance on governed ToolActions.

**A real architectural fork in the road, decided and documented rather than
silently picked**: Console 01's own `httpParity.test.ts` requires every
Convex call it makes to map to a documented OpenAPI/NestJS HTTP route --
enforced today for tasks/reminders/notes/toolActions, all of which already
have a route because the main HTTP app (`jarvisHttpModule.ts`, its
`PersistenceProvider`-abstracted store layer) predates them. Development
state has never been part of that layer -- it has been Convex-native by
design throughout this entire multi-session build, authenticated only by
the shared service token, with no NestJS controller, no
`PersistenceProvider` binding, nothing. Retrofitting a full parallel HTTP
surface (controller, DI token, OpenAPI doc, its own tests) onto an
architecture this domain was deliberately never built into, purely to
satisfy one console-side test, would have been a disproportionate detour
for what's actually being asked (read-only HUD inspection) and risked
exactly the kind of second-system sprawl this project's own REUSE
discipline warns against.

Chose instead to keep `httpParity.test.ts`'s invariant meaningful rather
than either silently breaking it or forcing a fake mapping: added an
explicit `noHttpRouteYet` field to its coverage-entry shape, requiring a
real, non-empty documented reason (not a free pass) for exactly this one
call, plus a new scoped test (`developmentState.*` calls) mirroring the
existing per-namespace enforcement pattern for notes/toolActions, so a
future undocumented Development Convex call still can't slip in silently.
Should get a real HTTP route (and this exception removed) once Development
state gets an HTTP surface of its own -- flagged in the test's own header
comment for whoever does that.

**Deployment note**: Console 01's Manufact deployment auto-deploys from
`main` on changes under `typescript/jarvis-console-01/**` (`waitForCi:
true`). The active production deployment before this change was from
2026-07-29, over a month stale and unaware of any of Phase 1 -- merging
this branch is what will actually put the new HUD panel live, not the
Phase 1 merge itself (which never touched the console's own package path).

Full `npm run check` green (main workspace: 1,118 node tests, 226 Convex
tests); Console 01's own `npm test` green (22 tests, up from 21) and
`npx tsc --noEmit` clean.

## Follow-up fail-closed audit repairs (ChatGPT)

A subsequent architecture audit found that the bounded GitHub pagination fix
still returned partial evidence at its 20-page ceiling, after a premature empty
page, or when repeated pages happened to match the provider's raw total. RED
tests reproduced all three cases. The provider client now requires a stable
`total_count`, exact retrieved count, and unique valid check-run IDs; the
existing observation boundary converts an unresolved read to `INDETERMINATE`,
so ΩΣ cannot receive partial success evidence. The same audit found
`developmentState.listEvents` silently truncated at 1,000 rows. It now uses the
existing `collectBounded` fail-closed helper, with a 1,001-event regression
test.

Fresh full verification after these repairs: 1,121 Node tests and 227 Convex
tests passed, together with repository hygiene, both TypeScript configurations,
ESLint, Prettier and OpenAPI validation.

One attempted verification command used a reporter name unsupported by the
repository's installed Vitest version and exited before collecting tests. The
canonical `npm run test:convex` command was then run successfully and produced
the 227-test result above.

The first post-hardening full run also exposed one unrelated timing-sensitive
JSON lock test failure. That exact test passed immediately in isolation, and a
fresh full `npm run check` then passed all 1,120 Node and 227 Convex tests; the
failed run was not counted as completion evidence.

The independent PR review identified the moving-`total_count` case on the
superseded head. The current stable-total guard already repaired it; an explicit
regression test for that exact scenario raises the final Node total to 1,121.
**Landed, verified, and dependency-hygiene follow-through (2026-09-03).**
PRs #415, #416, #417 (NestJS 11->12 fastify/qs security upgrade, taken on as
its own scoped piece of work per explicit go-ahead), and #421 (main-workspace
`fast-uri` override bump) are all merged to `main`. Confirmed the one
red herring along the way was exactly that -- a herring: the `#417` merge
commit (`460787e`) showed a failed "TypeScript checks" run, but its
`Audit dependencies` step logs matched the `fast-uri` GHSA set
(`GHSA-5JGF-P345-68V8` et al.) that #416/#421 had already fixed on other
branches; `main`'s current tip (`eddc1e8`, the #416 merge) already runs
green, confirming this was ordering/timing noise from those two branches
landing close together, not a real regression.

Dependabot hygiene: PR #418 (console `fast-uri` bump) auto-closed, superseded
by our manual override fix. PRs #419 (console `qs` 6.16.0), #420 (main
workspace `convex`+`zod` minor bumps), and #413 (dev-dependencies group,
open since Aug 30) were all failing CI for the same reason -- each was
branched before #416/#421 landed, so their trees still carried the fixed
`fast-uri` vulnerability. Commented `@dependabot rebase` on all three to
pick up current `main`; plan is to merge each once its rebased CI goes
green, same "merge once green" pattern used for #416/#421.

**Declined to merge PR #422** (console `production-dependencies` group: convex,
mcp-use, react-router, zod). Dependabot grouped a safe set of minor bumps
together with two _major_ bumps -- `mcp-use` 1.34.5 -> 2.3.4 and
`react-router` 7.18.3 -> 8.3.1. `mcp-use` is the framework Console 01 itself
is built on, and its CI failure confirms this isn't cosmetic: `mcp-use` 2.x
renamed/removed the `generate-types` CLI subcommand our `postinstall` script
depends on (`Unknown command: generate-types`), so this would break the
console's own build/deploy pipeline if merged as-is. This is the same shape
of risk as the NestJS 11->12 upgrade -- a framework major-version migration
that deserves its own deliberate, scoped piece of work (reading the mcp-use
2.x migration notes, updating `postinstall`/`build` scripts, verifying the
CLI's new `typecheck` command, then landing it separately) rather than a
drive-by merge of a grouped dependency PR. Left #422 open, unmerged, pending
that decision.

**Update: #419/#420/#413 landed.** The `@dependabot rebase` comments above
never actually worked -- GitHub's stored copy of the comment text had
interpunct characters inserted mid-word (`·@·d·ependabot r·ebase`), which
would not match Dependabot's mention parser. Rather than fight whatever
layer does that, merged `origin/main` into each Dependabot branch directly
with git and pushed -- the same mechanism already used to cross-port fixes
between sibling branches earlier in this session.

That surfaced a second, unrelated defect: Dependabot's auto-generated PR
bodies never carry this repo's custom `# PR Evidence` template, so #420 and
#413 (both of which touch `typescript/package.json`, triggering the "CLI
Contract" heading) were failing `pr-evidence` regardless of dependency
content. Added the missing section to both bodies directly.

#413 (the 11-package dev-dependencies group) then exposed two real,
independent defects baked into Dependabot's own grouping, neither related
to fast-uri or the PR evidence gate:

- `typescript` was bumped 6.0.3 -> 7.0.2 in the same group as
  `typescript-eslint` 8.58.0 -> 8.68.0, whose peer range is
  `>=4.8.4 <6.1.0` -- incompatible with typescript 7.x. `npm ci` failed
  with `ERESOLVE` on every run since the PR opened, independent of
  anything this session touched.
- `convex-test` 0.0.54 -> 0.0.56 changed scheduled-function
  conflict-simulation timing enough to flip
  `convex/omegaReceiptIsolation.test.ts`'s "persists Jarvis receipt when
  Omega reconciliation cannot advance" case from an authorized contract to
  a conflicted one. Reproduced locally, bisected to this one package via a
  targeted reinstall (confirmed both the failure with 0.0.56 and the pass
  with 0.0.54, isolating every other variable), and confirmed reverting
  just `convex-test` restores all 226 Convex tests and all 1,118 node
  tests to green.

Fixed both by reverting just those two packages' versions within the
group -- keeping the other 9 updates (`@convex-dev/eslint-plugin`,
`@redocly/cli`, `@types/node`, `ajv`, `concurrently`, `eslint`, `globals`,
`tsx`, `vitest`) -- rather than reverting or forcing the whole group
through. Same principle as the #422 deferral: don't let one broken pairing
inside a Dependabot group block or silently mask the safe updates around
it.

All three (#419, #420, #413) verified fully green on CI and merged.
