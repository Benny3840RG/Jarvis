# Jarvis PR maintenance

The Actions handover now performs independent advisory review and bounded repair.
It does not grant merge approval or declare a durable Development mission complete.

## Runtime path

1. Completion of TypeScript checks, PR Evidence Check or the autonomous builder
   wakes `jarvis-pr-maintenance.yml`. A 15-minute sweep recovers missed events.
2. The coordinator observes open, same-repository PRs targeting `main`. It waits
   for terminal CI evidence, including all three TypeScript checks, PR Evidence
   and four CodeQL language analyses. Checks must belong to the exact head and
   their trusted producer workflows. Forks are not eligible.
3. A review dispatch binds PR number, head, base and CI fingerprint in provider
   run metadata. An existing attempt for that snapshot prevents duplicate spend;
   a cancelled/failed attempt also counts. Comments are never scheduling authority.
4. The reviewer receives complete before/after contents of changed files as
   untrusted data. It runs separately with read-only permissions and no write
   token. It cannot execute candidate code, approve, merge or deploy.
5. A fresh publisher validates strict review output and re-observes the exact
   candidate and CI. Changed evidence discards the old review. Invalid output,
   unavailable context or invented file locations produces a blocked result.
6. A passing review plus trusted green CI produces `awaiting-owner`. Actionable
   findings or failed checks may request a repair only for an authentic generated
   `automation/issue-N/run-ID` candidate whose source issue remains approved.
7. The existing builder performs at most two repairs on that same branch/PR. It
   installs trusted dependencies and controls before inspecting candidate Git
   objects, applies the original cumulative policy before checkout and after
   editing, rechecks the exact head and approval, then performs an ordinary
   fast-forward push. No force push, duplicate PR or expanded file scope.
8. New candidate CI causes a new independent review. Owner approval/draft state,
   protected merge, post-merge verification and the existing queue advance remain
   separate gates. A merge is not an Omega completion record.

The reviewer may be the same model family as the builder but is a separate
invocation without the builder's conversation, writes or execution authority.
Its conclusion remains advisory; it is not a GitHub approving review.
The prepared prompt travels in bounded base64 chunks with a SHA-256 digest
and is reconstructed into a file on the isolated review runner. This preserves
the full admitted context without exceeding per-environment-entry limits.
The pinned Codex action already supplies `--skip-git-repo-check`; repeating
that single-use flag in `codex-args` prevents the reviewer from starting.
Only the separate trusted publisher has issue and pull-request write permissions
for the advisory comment; the model runner retains read-only permissions.

## Limits and failure handling

| Boundary                           | Behaviour                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Automatic review spend             | At most two invocations per candidate head across CI/base changes and manual reruns; sweeps never retry an identical attempted snapshot.         |
| Automatic repair spend             | At most two owning builder runs per PR; failures/cancellations consume attempts and repair reruns are refused.                                   |
| Review context                     | At most 40 changed files and 160 KiB decoded before/after content; no silent truncation. Oversized/binary/symlinked context blocks model review. |
| CI evidence                        | Bounded complete pagination, unique IDs, exact SHA, authenticated repository/run URL and producer; missing/untrusted data cannot pass.           |
| History                            | Queried from the PR's creation time; incomplete or over-limit history fails closed.                                                              |
| Existing manually authored PR      | Advisory review only. Opening a PR does not confer the approved-issue repair authority.                                                          |
| Forbidden/security/control changes | Owner repair required. Existing immutable forbidden-path/content rules are retained.                                                             |
| New commits or changed base/checks | Old review discarded; no stale push or stale pass.                                                                                               |
| Main moved or unhealthy            | No repair dispatch. Repair claims are not inferred from the request comment.                                                                     |
| Provider timeout during dispatch   | Unconfirmed result; inspect owning run history before retrying.                                                                                  |

The namespaced `jarvis-pr-maintenance/review` status is a handover aid. It never
impersonates TypeScript, PR Evidence or CodeQL checks and cannot satisfy the
existing ToolAction approval boundary. Blocked results retain their linked run.

Manual entry: Actions → **Jarvis PR maintenance** → Run workflow on `main`, mode
`sweep`; optionally specify a PR number. Exact review dispatch fields are normally
filled by the coordinator. A repository writer is required for manual entry.

## Activation and proof

The workflow activates only after the reviewed control-plane change lands on
`main`. It uses the existing `OPENAI_API_KEY` Actions secret; the reviewer receives
no Convex or deployment credentials. Required GitHub job permissions are declared
in the workflow. Unavailable credentials/permissions remain explicit failures.

Before calling the handover operational, observe a real generated candidate
through review → one deliberately failing safe test → bounded repair on the same
PR → exact-candidate CI → fresh review → owner gate. Observe the run IDs, candidate
SHAs, unchanged forbidden files and finite attempt count. Local mock-API tests
prove admission and refusal paths, not that this live drill has happened.

## Durable Development composition

An executable post-merge entry point now reuses the existing coordinator and
Convex Omega gateway. From `typescript/`:

```bash
node --import tsx src/tools/runDevelopmentCompletion.ts <existing-mission-id> <residual-uncertainty-0-to-1>
```

It requires `CONVEX_DEPLOYMENT=dev:<name>`, the matching `CONVEX_URL`, and the
existing `JARVIS_SERVICE_TOKEN`, `JARVIS_APPROVAL_TOKEN` and
`JARVIS_GITHUB_TOKEN`. Supply these through the authorised secret environment,
never command arguments or repository files. Uncertainty is an explicit operator
judgement, never defaulted to zero.

The command derives the repository, PR and reviewed head from an existing durable
`MERGED` subject, current event, succeeded receipt and user-approved merge action.
It supports the existing `post-merge-ci` criterion whose statement is exactly
“The merged commit exists and required post-merge CI passes.” Missing or different
bindings fail closed. It creates no missions, approves no actions and performs no
merge. Required TypeScript checks must come from a push on the target branch and
CodeQL from managed scanning on that branch; same-SHA PR checks do not suffice.

Run only while the durable Development state is `MERGED`. After success, inspect
the stored `COMPLETE`/Omega `complete` state instead of rerunning the command; a
completed-state invocation is explicitly refused without new writes.

The builder now waits for a trusted `mission` job. That job re-observes the
approved issue and source revision, then composes the existing orchestration,
Development and Omega APIs. The issue retains one subject ID across repairs.
Its original checklist criteria and `post-merge-ci` start unverified. The
recorded source SHA is forwarded to the worker; it is never resolved again
from a blank dispatch input.

An isolated `supervise` job renews the existing orchestration lease while the
worker runs. No Convex or approval credential reaches the candidate worker.
A separate trusted `checkpoint` job consumes the guarded build's published
SHA and PR URL, rechecks the live PR identity, commits the PR-and-head-bound
`BUILDING -> VERIFYING` checkpoint and pauses the claim, retaining its
monotonic fence. The review sweep waits for that exact durable checkpoint
before spending a review attempt. Failed supervision cancels the workflow. An expired lease
is refused, not revived or interpreted as successful work. Admission is capped
at three worker attempts (initial build plus two repairs).

The fresh review publisher advances the existing verification/review gates
using the exact candidate, CI fingerprint and review-run reference. A repair
receives the exact triggering review comment/run, with no whole-document
truncation. The next worker claims the same durable subject and repairs the
same PR. Repeated stage events are idempotent. Changed issue specifications,
foreign workers, stale heads and missing durable checkpoints fail closed.

`jarvis-development-completion.yml` wakes after maintenance, main checks and
merge events, and also sweeps every 15 minutes. For `READY_TO_MERGE` it stages
an existing T3, destructive, single-use GitHub merge ToolAction. It never
approves or executes that action. The owner uses the established approval and
execution route; the proposal binds head, base and CI fingerprint, rechecked
by the GitHub tool before execution. Changed evidence needs fresh owner review.
The observer commits `MERGED` only from the existing authoritative succeeded
receipt and reconciliation. A direct GitHub merge with no such receipt cannot
be relabelled as a governed merge.

For `MERGED`, the observer invokes the existing completion coordinator. The
owner must separately record real acceptance evidence/proofs for every
`issue-N` criterion through `omegaMissions.recordEvidence` and
`omegaMissions.recordValidationProof`; independent proofs retain the existing
approval-token gate. A model review verdict, test harness or green CI alone
never satisfies those criteria. Missing acceptance proof leaves Omega
incomplete even when post-merge CI passes. No completion claim is valid until
the durable Development and Omega records both confirm it.

### Development runtime configuration

Trusted Actions jobs require repository variables `CONVEX_DEPLOYMENT=dev:<name>`
and its exact `CONVEX_URL=https://<name>.convex.cloud`, the existing matching
`JARVIS_SERVICE_TOKEN` secret, and an explicit
`JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_<issue-number>` variable (for example,
`JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_493=0.05` only after owner approval
for issue #493). Admission reads only the dispatched issue's variable; no
repository-wide budget fallback exists. Missing issue-specific approval
configuration blocks both initial admission and repair. Independent post-merge proof
also requires the separate `JARVIS_APPROVAL_TOKEN` secret and explicit operator
judgement in `JARVIS_DEVELOPMENT_RESIDUAL_UNCERTAINTY`. The GitHub observer uses
the workflow's read-only token. Owner execution still uses the authorised
runtime's GitHub token and approval path.

The new `developmentWorkerClaims` functions must be deployed to that named
development deployment before activation. No production deployment is part
of this change. Missing runtime configuration blocks admission instead of
falling back to an untracked build.

### Commissioning evidence still required

Local integration tests exercise the real Convex function composition under a
test harness; they are not live commissioning. Record the real approved issue,
original and repair run IDs, exact candidate SHAs, independent review run and
findings, fresh CI, owner-approved ToolAction/receipt, restored post-merge
observations, acceptance proof IDs and final durable states. Never backfill
invented mission stages for an old PR merely to obtain a completion record.

Post-merge provider observations have been hardened to require the maintained
TypeScript checks and all four CodeQL analyses from trusted producers; missing,
neutral, skipped, stale or mismatched evidence cannot complete a mission.
