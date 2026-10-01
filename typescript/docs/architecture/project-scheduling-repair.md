# Project scheduling repair

PR #679 adds the optional `scheduledFor` calendar date. This continuation preserves
its contract, routes and backup shape. The date parser and 28 calendar regressions
published separately in `113cbd4` are retained unchanged.

An in-memory update edits a clone and publishes it only after all validation
succeeds. A rejected scheduled date must not leave a changed title or other field
in the authoritative map. JSON updates already publish only after validation.

## Regression evidence

`tests/projectScheduledUpdateAtomicity.test.ts` covers rejected-update atomicity
and successful set, preserve, reschedule and clear semantics. The atomicity case
failed against the previous store and passed after the repair in an isolated
Node 22 transpilation harness. Those cases were part of a 21-case local run with
zero failures. This is supplementary reproduction evidence, not a maintained
Node 24 full-suite result or live-host commissioning proof.

The four outstanding formatting failures are addressed without weakening the
formatter. The inbox description also explicitly excludes rejection actions;
its read-only registration and implementation are unchanged.

Fresh maintained CI and independent review remain required on the published
head. The local environment could not install dependencies, and J-arvis was
offline. No Convex smoke, customer email, deployment or merge was performed.

After #679 verification, independent review and Benny's merge decision, the
scheduling digest and dashboard remain the separate #680 mission.
