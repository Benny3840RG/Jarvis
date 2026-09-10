# Issue #493: owner handoff after control repairs

Scope: `Benny3840RG/Jarvis` issue #493 only. Its existing owner approval is for
an uncertainty budget of **0.05**, selected through
`JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_493`. This document grants no approval,
does not set residual uncertainty, and does not authorise the resulting PR merge.

## Current state and control landing order

- PR #496 is merged. Issue #493 has already built PR #498 at
  `3259fcd52cf1e4f9f45b8997983dd146364776d9` in run `34464212268`.
  Its candidate verification passed. Do not dispatch a duplicate initial build.
- Independent review stopped before model execution because the pinned action
  received duplicate `--skip-git-repo-check` arguments. PR #499 removes the
  duplicate. A failed review is not a review pass or a repair finding.

1. Land owner-reviewed PR #499 through the normal protected merge path. Its
   own advisory review is affected by the same trusted-main defect; never forge
   a passing status or bypass a required protection to bootstrap the repair.
2. Land the independently reviewed #497 after integration with current main and
   fresh required CI. Both prompt-transport and worker-recovery tests must remain
   in the workflow test list.
3. Commission the exact resulting `main` to the named `dev:` deployment through
   the existing commissioning gate. Verify `developmentWorkerClaims:recoverExpired`,
   `developmentWorkerClaims:finalize`, `developmentState:listPage` and the updated
   checkpoint pause binding, matching URL and existing service/approval authentication.
   Do not display credentials or treat local Convex tests as deployment verification.
4. Inspect the durable subject and checkpoint for #493/#498, then request a fresh
   independent review using the corrected trusted-main workflow. Preserve the
   existing issue-specific 0.05 budget; do not reset the mission or overwrite its
   checkpoint, supply residual uncertainty, or broaden issue approval.
5. Follow the evidence stages below. Approve only the concrete resulting owner
   merge action after its review/head/base/CI binding has been inspected.

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
