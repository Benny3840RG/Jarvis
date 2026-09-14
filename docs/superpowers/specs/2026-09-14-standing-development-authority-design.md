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

Admission resolves the budget in this order:

1. issue-specific repository variable `JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_<issue>` when deliberately supplied;
2. repository-wide `JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET` when configured;
3. the owner-approved built-in default `0.05`.

This removes per-issue configuration while preserving an explicit override mechanism. The resolved value is still passed through the existing durable Development admission and validation path. No merge, approval or deployment authority is implied.

### Candidate-code scope

The autonomous worker may modify ordinary application code, including:

- `typescript/src/integrations/`;
- `typescript/src/reconciliation/`;
- `typescript/src/persistence/`;
- ordinary `typescript/convex/` implementation files;
- other normal TypeScript source and matching tests.

The worker must still satisfy bounded diff size, binary/symlink restrictions, test-area matching and semantic patch scanning.

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

Authority-sensitive patch-content scanning remains a second independent barrier for credentials, permissions, approvals, deployment/commissioning and equivalent authority changes.

The purpose is not to make every security-related application file immutable. The purpose is to prevent an unattended worker from changing the controls that define its own permissions, merge authority, deployment authority or secret access.

## Failure handling

Failures are split into two classes.

### Retryable operational failures

A run that owned the mission but failed because of a transient dependency/worker/check condition should release `automation-in-progress` and remain queue-eligible for a bounded automatic retry. It must not immediately require Benny to clear `automation-blocked` or manually dispatch the workflow.

Automatic retry must be finite. Repeated failures for the same mission/stage must eventually stop and produce an actionable blocked receipt.

### Hard policy failures

A post-agent policy-guard failure, immutable-control failure, credential/permission failure, invalid mission identity, or exhausted retry budget remains fail-closed.

For a hard block, the receipt must state the failing stage and practical reason. Where an alternate agent/reviewer can inspect the failure without gaining authority, the system should hand the evidence to that path automatically. No alternate path may bypass the same control-plane restrictions.

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
- An explicit issue-specific budget still overrides the standing default.
- A repository-wide standing budget can override the built-in `0.05` default.
- A bounded repair touching reconciliation, persistence, integrations or ordinary Convex implementation files is not rejected solely because of its path.
- Automation controls, workflows, dependency manifests, schema/config authority and deployment/governance controls remain forbidden to unattended workers.
- Authority-sensitive patch content remains rejected.
- Retryable owned failures can be retried automatically without requiring the owner to clear `automation-blocked` or manually rerun checks.
- Hard policy failures still stop automatically and publish actionable evidence.
- Automatic retries are finite.
- Independent review and exact-head CI remain required before Jarvis PASS.
- No autonomous merge or deployment authority is added.
