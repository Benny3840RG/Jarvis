# Issue #493: owner handoff after control repairs

Scope: `Benny3840RG/Jarvis` issue #493 only. Its existing owner approval is for
an uncertainty budget of **0.05**, selected through
`JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_493`. This document grants no approval,
does not set residual uncertainty, and does not authorise the resulting PR merge.

## Control landing order

1. Review and owner-approve PR #496's final head (issue-specific admission,
   intact reviewer prompt transport, isolated publisher permission).
2. Review and owner-approve the accompanying handover-blocker repair PR's final
   head after integration with #496 and fresh required checks. Resolve any merge
   conflict in the TypeScript workflow test list by retaining both test entries.
3. Commission the resulting exact `main` revision to the named `dev:` deployment
   through the existing development commissioning gate. Verify the deployed
   `developmentWorkerClaims:recoverExpired`, `developmentWorkerClaims:finalize`
   and `developmentState:listPage` functions, matching deployment URL and existing
   service/approval authentication. Do not print credentials or substitute local
   Convex tests for deployment verification.
4. Inspect #493 and current durable state before dispatch. It is already approved;
   do not add a repository-wide budget, broaden approval, or create a second
   mission. The first attempt reported admission failure before a worker started;
   confirm that remains true rather than assuming no subsequent activity.
5. Dispatch the existing governed queue against freshly verified current main.
   Record the queue run and owning build run. Do not rerun an old workflow
   revision or directly implement #493 as part of these control fixes.

## Required evidence, in order

| Stage | Evidence to retain |
| --- | --- |
| Admission | `github-development:Benny3840RG/Jarvis:493`, immutable specification hash, source SHA, stored issue-specific budget and fenced worker claim |
| Build | Owning run ID, guarded publication, generated PR number and exact checkpointed head |
| Independent review | Separate reviewer invocation/run, authenticated complete findings, head, base and CI fingerprint |
| Repair, if warranted | Actual review finding; same PR; unchanged authorised scope; no more than two repair attempts; fresh CI and fresh independent review |
| Owner gate | Concrete T3 single-use ToolAction ID and exact reviewed PR/head/base/CI binding; owner approves that action through the existing route |
| Merge | Succeeded governed execution receipt, durable MERGED event, actual merge commit; a direct GitHub merge cannot substitute for the receipt |
| Post-merge | Actual target-branch push/dynamic checks, independent evidence/proofs for all issue acceptance criteria, explicit evidence-based residual uncertainty |
| Completion | Existing Omega policy permits completion; both Omega and Development are complete; the bound orchestration run is finalised |

If review finds no repairable defect, record **repair demonstration unproven**.
Do not add a defect to manufacture the demonstration. Passing CI alone cannot
verify the issue's business acceptance criteria or complete the durable mission.

## Failure and owner-reconciliation boundaries

- An expired initial worker can recover only after an independent GitHub read
  establishes its original owning run finished and neither its branch nor any
  open/closed PR exists. Recovery rotates the fence, records the failed checkpoint
  and preserves the attempt count. A late old worker cannot publish durable state.
- A branch, PR, uncertain API result, dead repair worker or exhausted attempt
  budget requires explicit reconciliation. Never infer that publication failed
  solely because the worker lease expired.
- Publication identity/observation failure records an unbound failed checkpoint;
  it does not accept a foreign PR or leave a live BUILDING claim unattended.
  A subsequent unbound retry must again establish that nothing was published.
- Closing a candidate or changing its reviewed binding does not reset the durable
  mission. Clearing `automation-blocked` is not a recovery procedure. Inspect and
  reconcile through existing owner controls; do not rewrite history, reuse a stale
  action, or silently broaden this issue's approval into a new mission.
- Rejected, revoked or expired owner actions are explicit stops. No automatically
  restaged proposal replaces an owner's decision. A fresh reviewed binding and
  any new action require explicit reconciliation/approval.
- Temporary post-merge check failures retain their failed observation as an
  inconclusive acceptance proof. They cannot complete the mission; a subsequent
  independent passing observation may satisfy that criterion. Existing permanent
  failed proofs are not erased by this change and still require reconciliation.

## Findings disposition

| Finding from #491 review | Repair or enforced boundary |
| --- | --- |
| Dead worker claim | Independently observed unpublished initial-worker recovery, atomically rotated fence and bounded retry; uncertain effects stop |
| Foreign originating issue run | Exact initial issue run title and original attempt required for repair |
| Publication mismatch strands BUILDING | Failed checkpoint before surfacing observation failure |
| Stale trusted check masks newer untrusted check | Select newest same-name result before checking producer; only trusted separate CodeQL quality output is exempt |
| Incomplete merge binding reaches completion | Reviewed base SHA and candidate CI fingerprint mandatory |
| Failed observation permanently poisons completion | Retryable observation records inconclusive proof, no completion request |
| Duplicate checkpoint regresses verification | No downgrade after the checkpoint was already committed |
| Blocked review or missing label loses durable event | Derive issue binding independently; durable PR/head checkpoint still mandatory |
| Untrusted CI becomes repair | Provenance/pending evidence leaves checkpoint available for a fresh trusted observation |
| Wrong branch/event authorises repair | Require main push/dynamic provenance for source checks |
| Rendered review exceeds repair input bound | Validate complete final rendered body before durable writes or publication; never truncate findings |
| Proposal identity omits base/CI | Full reviewed binding in action ID; stale/terminal action reconciliation remains explicit |
| Closed candidate requeue claim | Documented fail-closed owner reconciliation; clearing labels does not reset state |
| Recent-100 snapshot blocks completion | Stable-key paginated sweep, progress per page |
| Orchestration left running after completion | Idempotent finalisation gated by both authoritative completion states |
| Documentation invites artificial defect / misstates permissions | Corrected maintenance and builder/queue documentation |
