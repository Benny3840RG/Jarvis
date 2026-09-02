# Governed Development State Machine Phase 1 — Working Ledger

This ledger is an audit aid. Canonical authority remains the machine-readable
contracts and durable Jarvis records; checklist state here grants no authority.

## Current task

Hand off the published governed GitHub vertical slice for independent review
and merge-authority evaluation in pull request #415.

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

- Development boundary/schema/reducer and tests under `typescript/convex/development*` and `typescript/src/development/*`.
- Existing ToolAction, execution-receipt, reconciliation and orchestration boundaries and their tests.
- Existing ΩΣ mission transition plus its Development completion integration test.
- Existing OpenAI/Gemini Totality adapters and model-resource governance tests.
- Shared `typescript/src/actions/sha256.ts` and standard-vector test.

## Verification evidence

- Full Convex suite: 219 passed.
- Full Node suite after integrating remote branch work: 1,102 passed.
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
- Pull request #415 remains draft because the installed ready-for-review
  mutation requests a GitHub GraphQL field that no longer exists
  (`Repository.fullDatabaseId`). The evidence package is complete and both
  repository checks pass; independent review and merge remain intentionally
  unexercised.

## Next task

An authorised collaborator must clear the draft flag and provide independent
review. Merge may proceed only after that review establishes authority and the
required checks remain green.

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
