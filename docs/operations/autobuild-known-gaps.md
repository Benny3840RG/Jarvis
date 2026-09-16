# Autonomous-build known gaps

This is an evidence record for three gaps observed during the first live
`jarvis-autobuild.yml` missions for issues #550, #551 and #552. It is
recording-only: none of the three gaps is fixed by this document or by the
link added to the recovery runbook. Any repair requires a separately scoped
change to the relevant coordination or automation control, with fresh tests
and review.

## Autonomous workers and manual coordination claims

In two consecutive autonomous runs for issue #550 (run IDs `34937738004` and
`34938069210`), the Codex worker stopped before editing because the required
`AGENT COORDINATION v1` claim was absent. The worker treated the manual
dual-agent handover as a prerequisite even though this was a fully autonomous
dispatch, not a manual dual-agent mission. The reported blocker was:

> Blocked before editing: the required coordination handover does not contain
> the mandatory `AGENT COORDINATION v1` claim... I cannot modify files without
> that assignment.

The relevant exception is already documented in
[`dual-agent-coordination.md`](dual-agent-coordination.md): issues carrying
`automation-approved` belong to the maintained autonomous pipeline and must not
be manually claimed. The autonomous worker prompt is
`.github/automation/codex-autobuild-prompt.md`; inspect its coordination
guidance together with the manual protocol when reproducing or repairing this
confusion. The observed result was a skipped autonomous attempt, not evidence
that the issue was invalid or that manual ownership had been assigned.

## Diff-policy false positives for the development state machine

The autonomous mission for issue #551 (run `34938495016`) added a correct,
passing in-scope test, but the diff guard rejected it with
`authority-sensitive patch content at diff line 8` and later at diff line 25.
The affected files were:

- `typescript/src/development/stateMachine.ts`
- `typescript/tests/developmentStateMachine.test.ts`

The guard is `evaluatePatch` in
`.github/automation/validate-autobuild.mjs:188-189`. Its `sensitive` regular
expression rejects added or removed lines containing terms such as `authority`,
`approval`, `permission`, `deploy`/`deployment`, or
`commission`/`commissioning`, as well as token and control-related terms. The
exemption is limited to documentation paths matching `docs/**/*.md`. Those
words are intrinsic to this module's existing subject matter, including names
such as `authoritativeCommitter`, `missionAuthority`, and `workerAuthority`, so
an otherwise in-scope state-machine change can be structurally unable to pass
the guard. The line numbers above and the existing test/source files provide a
minimal reproduction target for a future guard repair.

## A crashed review evidence write leaves a stuck review-attempt lock

This candidate (issue #552, this pull request) hit a third gap while this
document was itself in review. The first `jarvis-pr-maintenance.yml` review
run for the exact candidate (`34944213898`) computed a passing review verdict
and clean CI, then crashed while durably recording that outcome:

```
Error: Durable operation failed: developmentEvidence:recordDevelopmentEvidence.
    at DevelopmentMissions.call (.github/automation/development-missions.mjs:42:13)
    at async DevelopmentMissions.review (.github/automation/development-missions.mjs:481:7)
```

The crash happened after a review-attempt record was already taken for that
exact head SHA. A second, otherwise-clean manual re-dispatch against the same
head (`34944398486`) was then rejected before it could retry:

```
Error: This exact candidate already has a review attempt.
```

With no automatic recovery path observed, the only way found to unblock the
candidate was pushing a new commit so review would run against a fresh head
SHA -- exactly the change that added this section. The underlying crash cause
inside `developmentEvidence:recordDevelopmentEvidence` was not established (the
durable-operation error message is deliberately generic and does not surface
the original Convex validation failure); reproducing it would need direct
access to the Convex deployment's logs for run `34944213898`, which this
session did not have.

Neither issue is fixed here. This report deliberately records the observed
evidence without changing the workflow, automation script, prompt, or source
files.
