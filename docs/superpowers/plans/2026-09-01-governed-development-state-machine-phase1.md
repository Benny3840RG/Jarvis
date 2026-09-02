# Governed Development State Machine Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove Jarvis governance end-to-end for one development mission: validated GitHub issue -> bounded worker execution -> verification/review -> merge evidence -> ΩΣ completion.

**Architecture:** `TRANSITIONS.yaml` and `EVENTS.yaml` are the sole machine-readable sources of truth for the Development mission. Human-readable transition/event documentation and TypeScript implementation are mechanically checked against them. Models/workers may request transitions, but the trusted commit boundary authenticates authority and atomically appends events/advances projections; completion remains exclusively ΩΣ-owned.

**Tech Stack:** TypeScript 6, Node 24, js-yaml, existing Jarvis test runner (`node --import tsx --test`), Convex transactions/OCC for durable commit implementation.

**Spec:** `JARVIS_ARCHITECTURE.md`, `JARVIS_CONSTITUTION.md`, `TRANSITIONS.yaml`, `JARVIS_TRANSITIONS.md`, `EVENTS.yaml`, `JARVIS_EVENTS.md`, `JARVIS_ROADMAP.yaml`

## Global Constraints

- Preserve existing ΩΣ completion authority; do not create a second completion path.
- Preserve existing ToolAction execution/claim/receipt/reconciliation authority boundaries.
- LLM/model output may propose but never authorise or commit authoritative state.
- Stable transition IDs are long-lived API identifiers.
- `REJECTED`, `FAILED`, and `INDETERMINATE` are distinct outcomes.
- Rejected transition attempts emit durable audit events without changing governed state.
- Authoritative transition/event history is append-only; materialised projections must remain derivable and auditable.
- Event schema versions and reducer versions are independent and have an explicit compatibility map.
- Commit-time authority is authenticated/enforced inside the trusted commit path, never trusted from caller-supplied role fields.
- `INDETERMINATE` resolves only through reconciliation/evidence; elapsed time alone cannot convert it to `FAILED`.
- Phase 1 covers the Development domain only; do not generalise prematurely.

---

### Task 1: Canonical machine transition source and governance contract

**Files:**
- Reuse: root `TRANSITIONS.yaml`; create root `EVENTS.yaml`
- Create: `JARVIS_ARCHITECTURE.md`
- Create: `JARVIS_CONSTITUTION.md`
- Create: `JARVIS_TRANSITIONS.md`
- Create: `JARVIS_EVENTS.md`
- Create: `JARVIS_ROADMAP.yaml`

**Interfaces:**
- Consumes: existing ΩΣ and ToolAction architecture.
- Produces: stable invariant IDs, transition IDs, side-effect classes, authority roles, event envelope, Phase 1 development lifecycle.

- [x] Reconcile root `TRANSITIONS.yaml` as the sole transition source; remove the competing YAML and add `EVENTS.yaml`.
- [x] Write the human governance artefacts around that registry.
- [x] Add automated alignment test: YAML transition IDs/from/to/side-effect/committer must match the TypeScript registry; Markdown must reference every YAML transition ID exactly once as a transition section. (`typescript/tests/developmentTransitionRegistryAlignment.test.ts`)
- [x] Confirm `MERGED -> COMPLETE` is ΩΣ-only. The generic Development reducer rejects completion-shaped events; the real ΩΣ path remains `omegaMissions.transition`.
- [x] Confirm operation retry semantics do not mutate state transitions blindly. (alignment test: "retry targets never blindly alias an authoritative transition ID" — every `retry_target` is `none` or an `*_operation` name, never a transition ID; full retry/resume behavior is Task 8)

### Task 2: Development transition kernel — RED

**Files:**
- Create: `typescript/tests/developmentStateMachine.test.ts`
- Create later: `typescript/src/development/stateMachine.ts`

**Interfaces:**
- Produces expected public API: `DEVELOPMENT_TRANSITIONS`, `evaluateDevelopmentTransition`, `DevelopmentState`, `TransitionRequest`.

- [x] Write initial failing tests for legal transition lookup, illegal-transition rejection, stale lease rejection, authority-envelope rejection, approval requirements, and ΩΣ-only completion.
- [x] Add failing test proving a rejected transition produces a durable rejection-event description and no projection mutation. ("a rejected transition describes a durable rejection without mutating the request")
- [x] Add tests proving the generic Development reducer cannot commit completion from caller-provided event data. The pure evaluator may assess real ΩΣ policy input but does not authenticate or grant ΩΣ authority.
- [x] Add failing test proving two workers racing from the same projection version cannot both commit conflicting transitions, at the kernel level via `expectedSubjectVersion`/`currentSubjectVersion`. ("stale subject version loses a claim race to an already-advanced worker") Full OCC-backed concurrent-commit proof against a real projection/store belongs to Task 4's event/reducer/commit-boundary tests, not this pure evaluator.
- [ ] ~~Add failing test proving a duplicated event ID is idempotent on projection replay.~~ Moved to Task 4 — this kernel has no event/projection concept yet (Task 2's own Interfaces list is `DEVELOPMENT_TRANSITIONS`/`evaluateDevelopmentTransition`/`DevelopmentState`/`TransitionRequest` only); Task 4 owns `events.ts`/`reducer.ts` and already lists this exact case in its own checklist.
- [ ] ~~Add failing test proving unsupported event-schema/reducer compatibility fails closed.~~ Moved to Task 4 for the same reason — event schema/reducer compatibility doesn't exist until `events.ts`/`reducer.ts` do.
- [x] Confirm the RED failure is specifically due to the missing implementation rather than malformed tests. (`ERR_MODULE_NOT_FOUND: .../src/development/stateMachine.js` before Task 3's implementation)

### Task 3: Development transition kernel — GREEN

**Files:**
- Create: `typescript/src/development/stateMachine.ts`
- Create: `typescript/src/development/transitionRegistry.ts`

**Interfaces:**
- `evaluateDevelopmentTransition(request): TransitionEvaluation`
- Runtime transition registry mirrors root `TRANSITIONS.yaml` and is validated at test time; event schemas mirror `EVENTS.yaml`.

- [x] Implement the minimum deterministic transition definitions required by the RED tests. (`transitionRegistry.ts` mirrors `TRANSITIONS.yaml` exactly, verified by alignment tests; `stateMachine.ts#evaluateDevelopmentTransition`)
- [x] Encode side-effect class, reversibility, approval rule, retry target, authoritative committer, and failure classification.
- [x] Do not treat role strings as credentials. The pure evaluator records role labels only; trusted identity and ΩΣ authority remain enforcement work for the existing Convex/ΩΣ boundary.
- [x] Run targeted tests and confirm GREEN. Current verification is recorded in the working ledger rather than frozen historical test counts.

### Task 4: Trusted commit boundary, events, reducers — RED then GREEN

**Files:**
- Create: `typescript/src/development/events.ts`
- Create: `typescript/src/development/reducer.ts`
- Create/modify tests under `typescript/tests/developmentStateMachine.test.ts` or a focused reducer test file.

**Interfaces:**
- `JarvisEvent` includes `eventSchemaVersion`, `correlationId`, optional `causationId`, actor separation, transition ID, evidence IDs, and reducer version.
- `applyDevelopmentEvent(projection, event)` is deterministic/idempotent.
- commit API accepts expected projection version for optimistic concurrency.

- [x] RED: event-envelope/schema compatibility validation. (unsupported `eventSchemaVersion`; unknown/incompatible `reducerVersion`)
- [x] RED: duplicate event replay produces no second projection change.
- [x] RED: conflicting expected-version commits cannot both win. (`InMemoryDevelopmentProjectionStore.commit` always re-reads its own current projection, never a caller-supplied one)
- [x] RED: rejected requests create audit events but no domain-state transition. (`DEV_TRANSITION_REJECTED` event emitted, projection unchanged)
- [x] GREEN: implement minimal event validator/reducer/commit contract. (`events.ts`, `reducer.ts`; current verification is recorded in the working ledger.)
- [x] Confirm projection records latest event ID, projection version, reducer version. (`DevelopmentProjection.lastEventId`/`projectionVersion`/`reducerVersion`, asserted directly in the first new test)

### Task 5: Reconciliation semantics for indeterminate operations

**Files:**
- Extend focused Development tests/implementation only.

- [x] RED: an indeterminate merge attempt cannot transition directly to MERGED or FAILED. (`MergeEvidence.operationOutcome`; `MERGE_OPERATION_INDETERMINATE`/`FAILED`/`REJECTED` are three distinct reason codes per JARVIS-015 — Development has no separate "FAILED" state, so "not FAILED" is proven by the operation staying rejected/at READY_TO_MERGE rather than being coerced into a state transition)
- [x] RED: reconciliation requires authoritative external observation before resolving an ambiguous merge outcome. (`INDETERMINATE_TO_MERGED` requires `reconciliationEvidence.externallyObserved === true` and `observedOutcome === "MERGED"`)
- [x] RED: timeout alone leaves reconciliation open. (elapsed time with `externallyObserved: false` is rejected identically to no evidence at all; a real observation of `"NOT_MERGED"` is also rejected, not silently treated as license to proceed)
- [x] GREEN: implement the minimum reconciliation state/evaluation contract. Current verification is recorded in the working ledger.

The former separate reconciliation state topology was removed. An ambiguous merge is now governed by the explicit READY_TO_MERGE -> INDETERMINATE transition and reconciliation exits from INDETERMINATE, with no timeout-to-failure shortcut.

### Post-Task-5 correction: MERGED -> COMPLETE was reinventing a parallel authority path

Before starting Task 6/Task 10, an explicit reality-check against the *real* existing runtime (not just the docs I'd already read) turned up a genuine JARVIS-018 violation introduced in Tasks 3-4: the kernel had invented completion-authority and completion-evidence shapes with no correspondence to anything real. The actual ΩΣ completion authority already exists and is fully implemented: `typescript/src/omega/policy.ts#evaluateOmegaCompletion` (pure, zero-dependency, criteria/proofs/evidence-driven) plus `typescript/convex/omegaMissions.ts#transition`, gated by `requireOwner(serviceToken)` — the real trusted-committer boundary, not a caller-supplied boolean.

Fixed: the kernel now imports and calls the real `evaluateOmegaCompletion` directly (`omegaCompletionInput: OmegaCompletionInput`, the exact real type), surfacing its real multi-reason `failures` array verbatim instead of a kernel-invented generic code. `OMEGA_COMMITTER_REQUIRED` (checking `committedBy.actorType === "omega"`) is kept as a labelling/audit check only, matching JARVIS_EVENTS.md's explicit statement that actor-role fields are "evidence about who participated... not authentication" — this pure kernel neither performs nor fakes real authentication. `evaluateDevelopmentTransition` returning `ALLOWED` for `MERGED_TO_COMPLETE` proves the supplied completion input satisfies the real policy; it does **not** prove the caller is really Omega, and must never be treated as if it did. The actual COMPLETE commit must call through `omegaMissions.transition` rather than letting this domain's reducer independently flip state to COMPLETE.

### Post-Task-5 extension: lease fencing (handover Task 5 — claims/lease/fencing/subject version)

The reality-check that found the Omega defect above also confirmed a genuine gap rather than a duplicate: the real `orchestrationSteps` lease (`convex/orchestrationState.ts`) has `leaseOwner`/`leaseToken`/`leaseExpiresAt` but issues `leaseToken` as a random UUID with no ordering — it cannot express "this lease was superseded by a newer one" independent of expiry. `LeaseInfo` was renamed to match that real field vocabulary (`leaseToken`/`leaseOwner`/`leaseExpiresAt`, was `leaseId`/`workerId`/`expiresAt`) and extended with a genuinely new `fencingToken: number` plus `TransitionRequest.currentFencingToken`, mirroring the existing `expectedSubjectVersion`/`currentSubjectVersion` OCC pattern. A lease whose `fencingToken` is behind the subject's current known token is rejected `STALE_FENCING_TOKEN` — distinct from `LEASE_EXPIRED` — even when it hasn't expired yet.

### Post-Task-5 extension: approval binding + effective risk (handover Task 6)

`ApprovalRef` gained the exact-effect-binding fields the handover's "Approval model" specifies: `subjectId`, `transitionId`, `proposalHash`, `approvedSha`, `effectHash`, `authorityEnvelopeHash`, `effectiveRisk`, `policyDecisionFingerprint`. No mutable `consumed`/`exercised` flag was added (handover "Approval use" — `EXERCISED` must be derived from durable execution-intent history, not stored on the approval; that derivation is Task 7's job once the real ToolAction execution-intent lifecycle is wired in). Hashing reuses the repository's real, already-shared canonical encoder (`src/actions/canonicalJson.ts`, the same one `toolExecution.ts`/`quoteSendTool.ts` already use) rather than inventing a new one, per "one canonical encoder." `PolicyVersion`/`VersionedPolicy`/`RetroactiveInvalidation` are preserved verbatim as types but not yet consumed by a gate — flagged explicitly as deferred, not silently dropped.

A real gap was caught and fixed while wiring the risk gate: the previous implementation trusted a caller-supplied `riskClass` directly, so a caller could bypass the approval requirement on the merge transition (side-effect class S4) simply by asserting `riskClass: 0`. `effectiveRisk` is now `max(deterministic floor by side-effect class, riskClass, modelSuggestedRisk, evidenceDerivedRisk)` — a caller/model may raise risk, never lower the floor, per the handover's "Risk" section. The approval gate additionally verifies (when the caller supplies the live data to compare against) that the approval is bound to the exact same transition ID, subject, effect (hashed from `effectPayload`), authority envelope, and a current (non-stale) policy-decision fingerprint — each a distinct rejection reason (`APPROVAL_TRANSITION_MISMATCH`/`APPROVAL_SUBJECT_MISMATCH`/`APPROVAL_EFFECT_MISMATCH`/`APPROVAL_AUTHORITY_ENVELOPE_MISMATCH`/`APPROVAL_STALE_POLICY_CONTEXT`) so a stale or mis-scoped approval can't be silently reused.

### Post-Task-6 note: Task 7 (execution-intent integration) — REUSE decision recorded, implementation deferred

Investigated whether there's kernel-level work to do now for "derive EXERCISED from durable execution-intent history; extend ToolActions' existing durable pre-provider effect record rather than adding a new ExecutionIntent store." Finding: given the *current* registry topology, the only `risk_dependent` transition (`READY_TO_MERGE_TO_MERGED`) has no legal path back to its own `from` state after a successful commit, so an "approval already exercised, reject reuse" gate would be defending against a replay the state graph doesn't currently permit — adding it now would be speculative, untested-by-anything-real complexity (the "don't overbuild" principle this build's own instructions call out). The real, concrete decision instead: when Task 11 (GitHub vertical slice) builds the actual merge execution, that S4 external effect should be defined as a `ToolAction` reusing `ToolExecutionService`/`toolActions.ts`'s existing claim/single-use-consumption/receipt/reconciliation lifecycle (the real `singleUseClaimedAt`/`singleUseClaimId` atomic claim gate *is* the durable pre-provider effect record the handover asks to extend) rather than inventing a parallel Development-specific execution engine. Recording this now so Task 11 doesn't have to rediscover it, without fabricating Convex wiring today that nothing yet calls.

### Post-Task-6 extension: retry disposition for failed merges (handover Task 8)

A `FAILED` merge outcome now derives a `retryDisposition` (`RESUME_SAME_OPERATION` | `NEW_EXECUTION_REQUIRED` | `NO_RETRY`) instead of being treated as uniformly retriable, per the handover's explicit "FAILED should derive retry disposition... do not make all failures automatically retriable." `MergeEvidence` gained `retryable?: boolean` for an explicit unrecoverable-failure signal. Caught and fixed a design mistake while building this: the first implementation re-derived "did the effect change" by recomputing the same effect hash the approval-binding gate (Task 6) already checks — which is unreachable dead code, since a changed effect hash always fails `APPROVAL_EFFECT_MISMATCH` earlier in gate order, before the merge-outcome gate is ever reached. Fixed by comparing against `approval.approvedSha` instead — a distinct field (the handover explicitly lists `approvedSha` and `effectHash` as separate approval fields) that can differ independently of the generic effect hash, so the check is actually reachable and non-redundant. `retryDisposition` is only ever set alongside `MERGE_OPERATION_FAILED`; `REJECTED`/`INDETERMINATE` outcomes and `ALLOWED` evaluations never carry one.

### Post-Task-8 addition: audit trail on committed/rejected events

Small addition after a self-review pass (handover Task 15 flavor — checked for duplication/unused exports/dead code, found none beyond what's already documented as deliberately deferred): `InMemoryDevelopmentProjectionStore.commit`'s `DEV_TRANSITION_COMMITTED` event payload now records `approvalId` when the transition used one, and its `DEV_TRANSITION_REJECTED` payload records `retryDisposition` when present — so the durable history itself shows which approval authorised a commit and what disposition a failed merge carried, without adding any new mutable state.

### Task 10: minimal model resource governance

**REUSE check first** (handover's own instruction — "before adding new routing code, inspect current provider/model abstractions"): this repo has no `ModelProfile`/capability-metadata type and no LLM token/cost telemetry anywhere. It does have a real, extendable precedent for budgets — `src/totality/totalityQuota.ts`'s `TotalityQuota` (lease-acquire/release, typed rejection codes, bounded config) — scoped to the Totality reasoning boundary/time-window, not to a Development mission's cumulative usage, so not directly reusable but its *pattern* is mirrored rather than reinvented. The only existing "model identity" precedent is `totalityFactory.ts`'s env-driven `"openai" | "gemini"` reasoner selection, with model identifiers hardcoded as private `DEFAULT_MODEL` constants (`"gpt-5.6"`, `"gemini-2.5-flash"`) in the two reasoner files — those exact identifiers are reused (as string literals, not imports, to avoid coupling to private constants) in the new trusted `MODEL_PROFILES` registry below. No escalation mechanism exists anywhere. Full findings recorded via a research subagent before writing any code.

New (justified — nothing above satisfies these): `typescript/src/development/modelResourceGovernance.ts` implements exactly the handover's stated minimum scope, no more: a trusted `MODEL_PROFILES` registry (routing only ever resolves identity via lookup here — a caller-constructed profile-shaped object is never trusted, satisfying "model identity comes from trusted runtime/provider metadata"); `routeModelForRequirement` (least-cost candidate satisfying `minimumCapability`, which is a floor a `modelSuggestedCapability` can never lower — mirroring the transition kernel's effective-risk-floor pattern); `aggregateModelUsage` (pure aggregation over durable `ModelInvocationRecord`s, never a running mutable counter, so mission usage totals are always re-derivable from history — the same "derive from durable history" principle used for the transition kernel's projections); `checkCognitiveBudget` and `deriveEscalationDisposition` (bounded spend/calls/retries/context and bounded/reason-carrying escalation).

Architectural note deliberately proven by a test, not just asserted in a comment: `checkCognitiveBudget`'s result type (`{withinBudget, reasons}`) has no field resembling transition/execution admissibility at all — it structurally cannot be used to bypass or substitute for `evaluateDevelopmentTransition`'s gates, satisfying "budget exhaustion does not bypass verification" by construction rather than by convention.

The specific cost/latency/context-window figures in `MODEL_PROFILES` are explicitly labelled illustrative Phase-1 placeholders, not verified real-world pricing — flagged rather than presented as researched fact, since fabricating specific numbers for real commercial models would be dishonest.

The model-resource tests cover the handover's required routing, trust, budget, escalation and aggregation cases. Current results belong in the working ledger, not this historical narrative.

### Fix before starting real persistence: fencing token was never actually enforced end to end

While preparing the Convex integration, found that `DevelopmentProjection` never tracked a `fencingToken` field — `InMemoryDevelopmentProjectionStore.commit()` never passed `currentFencingToken` into `evaluateDevelopmentTransition`, so the fencing gate built in the earlier lease-fencing extension only ever ran with `currentFencingToken: undefined`, meaning it could never actually reject anything through the commit boundary — only the pure evaluator's own unit tests exercised it directly. Fixed: `DevelopmentProjection` gained `fencingToken?: number`; a committed event's payload now carries `leaseFencingToken` when the request had a lease; `applyDevelopmentEvent` advances the projection's known fencing token from that payload (so replay reconstructs it correctly, the same "derive from durable history" principle used elsewhere); `commit()` now passes `currentFencingToken: current.fencingToken`.

### Current authority boundary and remaining work

The in-memory Development projection store is a deterministic test harness,
not an authoritative persistence or execution path. It must not be wired to a
worker, provider or completion caller as if it were durable governance.

Still pending before the Phase 1 mission can be called complete:

- a Convex mutation that atomically reads authoritative state, validates
  identity/claim/lease/fencing/approval/policy/version, appends history and
  reduces the durable projection;
- a ToolAction-backed GitHub merge operation reusing existing execution
  intent, receipts, idempotency and reconciliation;
- GitHub issue/PR/provider observations and post-merge evidence;
- completion through the existing ΩΣ `omegaMissions.transition` path,
  never through the Development reducer.

### A more serious fix found the same way: the commit boundary never actually validated `from` against persisted truth

While writing the first Convex integration test for a rejected transition, found that **neither** commit boundary (`InMemoryDevelopmentProjectionStore` nor the new Convex mutation) ever cross-checked a caller-supplied `TransitionRequest.from` against the subject's real persisted `current.state`. `evaluateDevelopmentTransition`'s `STATE_MISMATCH` gate only ever compared `request.from`/`request.to` against the *transition definition's own registered shape* — so as long as a caller's claimed `from` happened to match whatever the transition ID's registry entry expected, the request was evaluated as if that were true, regardless of what the subject's real state actually was. A caller could claim to be transitioning from a state the subject was never actually in. This is a significant gap that existed from Task 4 onward and was never caught because every prior test (in this kernel's own suite) always kept its `from` fixture honestly in sync with the seeded state — nothing ever tried to lie.

Root-caused against the real precedent already in this codebase: `convex/omegaMissions.ts#transition` never accepts a client-supplied "current state" at all — it derives it from `mission.state` (the persisted document) and only accepts the caller's desired `nextState`. Fixed both commit boundaries the same way: `InMemoryDevelopmentProjectionStore.commit()` now builds a `groundedRequest` with `from: current.state` (ignoring whatever the caller's own request object said), and the Convex `commit` mutation dropped `from` from its public args entirely, deriving it from `subject.state` instead — so a client-supplied "from" is never even accepted as a value that could be trusted, structurally, not just by convention.

Fixing this exposed a second, more subtle issue: once `from` is correctly grounded in truth, a version-stale racer's `from` has *also* necessarily moved by the time it's evaluated (state and subject version change together under this kernel's model), so checking `STATE_MISMATCH` before `STALE_SUBJECT_VERSION` would make the latter — the more specific, more actionable "your view was stale, refresh and retry" diagnostic — effectively unreachable through any real commit boundary, masked behind a more generic "this transition doesn't apply here" one. Reordered: the subject-version check (when the caller explicitly supplies `expectedSubjectVersion`) now runs before the state-shape check, a deliberate, documented deviation from the handover's own generic illustrative gate order, justified by this concrete implementation reality rather than convenience.

3 tests updated to reflect correct behavior (2 in the in-memory reducer suite, 1 in the new Convex suite), 1 new test added proving `from` is grounded rather than trusted. All 68 pure-kernel/reducer tests plus the full Convex suite green after the fix.

### Task 7 (execution-intent integration), second half: real Convex persistence

Built the actual Convex-backed trusted commit boundary the plan always deferred: `convex/developmentValidators.ts` (Convex `v.*` validators mirroring the TypeScript types — actor refs, lease, capability envelope, approval, merge/reconciliation evidence, event/subject documents), `convex/developmentSchema.ts` (`developmentTables`, following the exact `omegaSchema.ts`/`omegaTables` pattern already established in this repo rather than cramming into the monolithic `schemaBase.ts`), and `convex/developmentState.ts` (`create`/`get`/`listEvents`/`commit` mutations and queries, authenticated via the real `requireOwner`).

The `commit` mutation reuses the pure kernel and reducer **verbatim** — `evaluateDevelopmentTransition` and the now-exported `buildEvent`/`applyDevelopmentEvent` are called directly, not re-derived; this mutation's own code is limited to authentication, a fresh read, an idempotency check (an indexed lookup on `(ownerId, subjectId, eventId)`, replacing the in-memory store's `Set`), and persistence — exactly matching `JARVIS_EVENTS.md`'s own "Convex transaction boundary" description written back in Task 1. `DEV_TRANSITION_MERGED_TO_COMPLETE` is explicitly refused by this mutation (a thrown error naming why) rather than accepted: real ΩΣ completion must go through `omegaMissions.transition`, and this generic mutation must never become a second completion-commit path.

`convex/_generated/api.d.ts` needed a manual addition for the new `developmentState` module: this repo's checked-in generated API types are already stale relative to source (missing `omegaMissions` too, pre-existing, never surfaced since no test imports it via `api.*`) and regenerating properly requires a live `CONVEX_DEPLOYMENT` this sandbox doesn't have. Added only the one entry this PR's own tests need, via the exact same mechanical pattern every other entry follows, rather than attempting a full regeneration of unrelated stale entries.

`convex/developmentState.test.ts` (convex-test/vitest, mirroring `orchestrationState.test.ts`'s established harness pattern) proves the guarantees hold through the **real** persistence boundary, not just the pure evaluator: a legal commit advances state/version/fencing token; an illegal one leaves the subject untouched and still records an audit event; the same event ID replayed twice is idempotent (no second state change, same event row returned); two workers racing the same claim via real concurrent `Promise.allSettled` calls serialize to exactly one winner through Convex's actual OCC (not a simulated one); a stale fencing token is rejected through the real mutation; `MERGED_TO_COMPLETE` is refused outright. 9 new tests, Convex suite now 195/195 (was 186), full `npm run check` green (1068 node tests total).

### Task 11, step 1: GitHub vertical slice begins — `deterministic_spec_validator`

First piece of the GitHub vertical slice, built in direct response to explicit go-ahead for this phase specifically (kept bounded per the standing caveat: no live GitHub API calls in the governed pipeline itself without a further, separate go-ahead). The registry's `DEV_TRANSITION_SPECIFIED_TO_READY` entry has named an evaluator called `deterministic_spec_validator` since Task 1, but nothing ever implemented it — until now.

`typescript/src/development/specValidation.ts`: a pure function `validateGithubIssueSpecification(issue, policy)` mapping a `GithubIssueSnapshot` (a plain data shape — owner/repo/issueNumber/title/body/labels/state/htmlUrl — deliberately not a live SDK type, so this module has no dependency on how the snapshot was fetched) to either a validated `DevelopmentSpecification` or a list of typed rejection reasons. Gates checked: issue must be `open` (`ISSUE_NOT_OPEN`), body must clear a minimum length floor (`BODY_TOO_SHORT`), title must not exceed a maximum length (`TITLE_TOO_LONG`), all policy-required labels must be present (`MISSING_REQUIRED_LABEL`), and at least one markdown checklist item (`- [ ] ...`) must be present as acceptance criteria.

That last gate deliberately reuses `"no-acceptance-criteria"` — the exact string `src/omega/policy.ts#evaluateOmegaCompletion` already uses for the identical concept — rather than inventing a second, differently-spelled reason code for the same idea, since a validated `DevelopmentSpecification`'s `acceptanceCriteria` is intended to eventually flow into `omegaMissions.create`'s `acceptanceCriteria` argument: one vocabulary across that future bridge, not two that could silently drift apart.

`deriveDevelopmentSubjectId` and `computeSpecHash` reuse the same canonical-encoding digest pattern already established in `stateMachine.ts` (`canonicalJson` + `sha256` + a versioned prefix), rather than a third hashing implementation — subject IDs are deterministic functions of `(owner, repo, issueNumber)` so the same issue always maps to the same Development subject, and `specHash` changes whenever the objective or acceptance criteria change, giving a stable content fingerprint for later staleness checks (the same role `computeEffectHash`/`computePolicyDecisionFingerprint` play for transitions).

Explicitly out of scope here, by design: no GitHub API client, no HTTP calls, no octokit dependency — this module only ever operates on an already-fetched, already-typed snapshot. Fetching that snapshot for real is a separate, later piece, and is exactly the kind of code path that needs its own explicit go-ahead before it starts making live calls under Jarvis's own authority.

9 new tests in `typescript/tests/developmentSpecValidation.test.ts`: valid-issue happy path, closed-issue rejection, no-checklist rejection (cross-checked against Omega's own reason string), missing-label rejection, too-short-body rejection, too-long-title rejection, subject-ID determinism/uniqueness, and spec-hash stability/sensitivity (including direct recomputation matching validation's own output). Full `npm run check` green: 1077 node tests (was 1068), 195 Convex tests (unchanged — this piece has no Convex dependency yet), type-check/lint/format/openapi all clean.

### Task 6: PR evidence package

**Files:**
- PR description/evidence only unless CI reveals a required repository change.

- [ ] Record test/type/lint evidence.
- [ ] Record YAML/Markdown/TypeScript alignment result.
- [ ] Record race/idempotency/schema-compatibility stress results.
- [ ] Record authority-boundary checks, including trusted ΩΣ identity at the existing completion path.
- [ ] Record known non-goals and remaining Phase 1 work.
- [ ] Keep PR unmerged if any constitutional or completion-authority check is unresolved.
