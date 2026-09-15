# Standing Development Authority Design

## Purpose

Reduce owner babysitting without granting Jarvis autonomous merge or deployment authority.

The current automation is safe but over-gated in three places:

1. every mission requires an issue-specific `JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_<issue>` value even when the owner has already approved the same bounded Development risk envelope;
2. the autonomous diff guard blanket-forbids broad application-code areas such as Convex reconciliation, persistence, integrations and other ordinary implementation paths, so approved missions can be impossible to complete through the governed worker;
3. an owned build failure is converted directly into `automation-blocked`, which forces a manual owner retry even for retryable runner/check failures.

Issue #530 demonstrated all three failure modes. The mission was owner-approved, then stopped for a missing issue-specific budget, then the worker reached the code but the guard rejected the exact reconciliation/persistence files required by the accepted repair. Claude ultimately had to open a manual PR outside the governed worker path.

## Desired operator experience

For a normal approved Development mission, Jarvis should perform the repetitive loop itself:

`approved issue -> build -> checks -> bounded repair -> checks -> independent review -> repair if needed -> exact-head PASS`

Benny should be interrupted only when one of these is true:

- the candidate has exact-head Jarvis PASS and is ready for the owner merge decision;
- the requested change would alter Jarvis's control plane or protected authority boundary;
- a hard policy violation is detected;
- bounded automatic retry/repair has been exhausted and a human decision is genuinely required;
- deployment or commissioning approval is required.

Merge and deployment remain owner-only.

## Authority model

### Standing bounded Development budget

The owner approves a standing default uncertainty budget of `0.05` for ordinary Development missions.

Admission resolves the budget as follows:

1. an issue-specific repository variable `JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_<issue>` is used when deliberately supplied;
2. otherwise durable Development admission uses the owner-approved built-in default `0.05`.

This removes routine per-issue configuration while preserving an explicit per-mission override for exceptional cases. The resolved value is still passed through the existing durable Development admission and validation path. No merge, approval or deployment authority is implied.

### Candidate-code scope

The autonomous worker may modify ordinary application code, including:

- `typescript/src/integrations/`;
- `typescript/src/reconciliation/`;
- `typescript/src/persistence/`;
- ordinary `typescript/convex/` implementation files;
- other normal TypeScript source and matching tests.

Sensitive application areas remain test-gated. Each guarded module requires added test lines in its own corresponding test file: `typescript/tests/<module>.test.ts` for `src/` modules, or a sibling `<module>.test.ts` for Convex modules. Unrelated area tests, deleted tests and rename-only changes do not qualify. The worker must also satisfy bounded diff size, binary/symlink restrictions, test-area matching and patch scanning. Implementation and regression evidence are in `.github/automation/validate-autobuild.mjs` and `.github/automation/validate-autobuild.test.mjs`.

### Locked control plane

Unattended workers must remain unable to modify the machinery that defines or expands their own authority. The hard path deny-list continues to cover at least:

- `.github/workflows/`;
- `.github/actions/`;
- `.github/automation/`;
- dependency manifests/lockfiles;
- environment/secret material;
- Git attributes/modules;
- Convex schema/config authority;
- deployment/commissioning implementation and canonical deployment/governance policy documents.

Authority-sensitive patch-content scanning remains an additional keyword filter for credentials, permissions, approvals and deployment/commissioning changes. It cannot detect arbitrary logic errors, including a caller-controlled clock hidden behind ordinary comparisons. Matching test filenames likewise do not prove behavioral coverage. Executable regression tests and independent review remain required.

The purpose is not to make every security-related application file immutable. The purpose is to prevent an unattended worker from changing the controls that define its own permissions, merge authority, deployment authority or secret access.

## Failure handling

Failures are split into two classes.

### Retryable operational failures

A run that owned the mission but failed before publication because of a transient dependency/worker condition should remain queue-eligible for a bounded automatic retry. The trusted recovery workflow may clear `automation-blocked` only after binding itself to the exact completed builder run and its bot-authored diagnostic receipt.

Automatic retry is finite: at most two automatic retries after the initial failed attempt. Repeated failure then stops and produces an actionable hard block.

### Hard policy failures

A post-agent policy-guard failure, invalid/ambiguous diagnostic evidence, stale mission lock, non-retryable failure, or exhausted retry budget remains fail-closed.

The recovery classifier rejects missing, unknown and contradictory stage outcomes before considering a retry. An explicitly recorded `unavailable` outcome remains distinct from an invalid field. See `.github/automation/autobuild-recovery.mjs` and `.github/automation/autobuild-recovery.test.mjs` for the validation and regression cases.

For a hard block, the system keeps `automation-blocked` and automatically asks the existing read-only Claude path to inspect the exact run evidence and advise the smallest repair. Claude receives no content-write, approval, merge or deployment authority from this handoff.

## Review and merge flow

The existing independent PR maintenance loop remains authoritative for candidate review:

- exact candidate CI is required;
- review findings may dispatch bounded repair automatically for eligible generated PRs;
- repair must be rechecked on the new exact head;
- stale review evidence never transfers to a changed head;
- Jarvis PASS is required before the owner merge decision.

The end-state is:

`Jarvis PASS -> Benny merge decision`

not:

`Jarvis PASS -> autonomous merge`.

Production deployment/commissioning remains separately owner-controlled.

## Acceptance criteria

- A newly approved ordinary Development issue can enter admission without creating an issue-specific uncertainty-budget variable.
- An explicit issue-specific budget still overrides the standing `0.05` default.
- A bounded repair touching reconciliation, persistence, integrations or ordinary Convex implementation files is not rejected solely because of its path when matching tests are present.
- Automation controls, workflows, dependency manifests, schema/config authority and deployment/governance controls remain forbidden to unattended workers.
- Authority-sensitive patch content remains rejected.
- Retryable pre-publication failures can be retried automatically without requiring the owner to clear `automation-blocked` or manually rerun checks.
- Hard policy failures still stop automatically and publish actionable evidence.
- Hard blocks automatically request read-only Claude advice without granting implementation or merge authority.
- Automatic retries are finite.
- Independent review and exact-head CI remain required before Jarvis PASS.
- No autonomous merge or deployment authority is added.
