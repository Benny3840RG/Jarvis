# Autonomous-build known gaps

This is an evidence record for two gaps observed during the first live
`jarvis-autobuild.yml` missions for issues #550 and #551. It is recording-only:
neither gap is fixed by this document or by the link added to the recovery
runbook. Any repair requires a separately scoped change to the relevant
coordination or automation control, with fresh tests and review.

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

Neither issue is fixed here. This report deliberately records the observed
evidence without changing the workflow, automation script, prompt, or source
files.
