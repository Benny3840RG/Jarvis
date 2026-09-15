# Jarvis PR maintenance

The Actions handover performs independent review and bounded repair. Its
exact-candidate `jarvis-pr-maintenance/review` status is the required Jarvis PASS
for agent-authored PRs. It does not grant owner approval, merge authority or a
durable Development completion claim.

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
The separate trusted publisher has issue and pull-request write permissions for
the advisory review comment. The trusted coordinator has issue-write permission
for diagnostic base-drift notices; it checks out only the pinned workflow revision.
The model runner retains read-only permissions.

When a PR base differs from observed main, the sweep preserves its exact-base
review gate and posts a diagnostic notice on that PR. It identifies the observed
head, PR base and main SHA and asks the implementation owner to update the branch
and rerun verification. It creates no review result, status, approval or completion
record. Existing results retain their original SHA scope.

The coordinator reads at most ten pages of 100 comments, recognizes only its
GitHub Actions bot notice, and rechecks candidate/main identity before writing.
It updates the same notice when the observation changes and leaves identical
observations untouched. Failed or incomplete comment evidence remains unconfirmed;
other eligible PRs still progress. After an uncertain write, the next sweep reads
provider comments before deciding whether another write is needed. Successful
writes require provider readback. Sweep concurrency remains serialized by the
existing workflow group. Live notification proof requires this change on main.

## Limits and failure handling

| Boundary                           | Behaviour                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic review spend             | At most two invocations per candidate head across CI/base changes and manual reruns; sweeps never retry an identical attempted snapshot.                                           |
| Automatic repair spend             | At most two owning builder runs per PR; failures/cancellations consume attempts and repair reruns are refused.                                                                     |
| Initial-build operational retry    | At most two trusted automatic retries after the initial failed attempt, and only for classified pre-publication dependency/worker failures.                                        |
| Review context                     | At most 40 changed files and 160 KiB decoded before/after content; no silent truncation. Oversized/binary/symlinked context blocks model review.                                   |
| CI evidence                        | Bounded complete pagination, unique IDs, exact SHA, authenticated repository/run URL and producer; missing/untrusted data cannot pass.                                             |
| History                            | Queried from the PR's creation time; incomplete or over-limit history fails closed.                                                                                                |
| Existing manually authored PR      | Advisory review only. Opening a PR does not confer the approved-issue repair authority.                                                                                            |
| Control-plane changes              | Owner repair required. Workflow/automation controls, dependency manifests, env/secrets, schema/config authority and deployment/governance stay hard-blocked.                       |
| Sensitive application source       | Each guarded module requires additions to its own corresponding test; unrelated, deleted or unchanged tests do not qualify. Patch scanning and cumulative diff limits still apply. |
| New commits or changed base/checks | Old review discarded; no stale push or stale pass.                                                                                                                                 |
| Main moved or unhealthy            | No repair dispatch. Repair claims are not inferred from the request comment.                                                                                                       |
| Provider timeout during dispatch   | Unconfirmed result; inspect owning run history before retrying.                                                                                                                    |

A completed initial builder failure is observed by
`jarvis-autobuild-recovery.yml` from trusted default-branch workflow code. The
recovery job binds the exact run to its bot-authored diagnostic receipt. A
classified retry removes `automation-blocked` and re-enters only through
`jarvis-queue-advance.yml`; it never dispatches a side-channel worker. Guard
failures, invalid/ambiguous evidence, stale locks and exhausted retry budgets stay
blocked and automatically request read-only `@claude` advice. That advisory path
has no content-write, approval, merge or deployment authority.

The module test rule in `.github/automation/validate-autobuild.mjs` requires
`typescript/tests/<module>.test.ts` for guarded `src/` modules, or a sibling
`<module>.test.ts` for Convex modules (including the same nested directory).
See `.github/automation/validate-autobuild.test.mjs` for unrelated-test,
per-module, deletion and rename-only regressions. This is a file-level check;
neither test naming nor keyword scanning proves the changed logic is safe.
Executable tests and independent review must assess the actual behavior.

Recovery classification in `.github/automation/autobuild-recovery.mjs` rejects
missing, unknown and contradictory stage outcomes. Explicit `unavailable`
values from interrupted builds remain distinct from malformed fields.
`.github/automation/autobuild-recovery.test.mjs` exercises these refusal paths
and the existing finite retry budget.

The recovery workflow persists each retry attempt before unblocking the issue.
It rejects duplicate source-run recovery and uses a complete provider history
window, capped at 100 runs, to refuse stale failures when a newer build exists.
Unavailable or incomplete history leaves the issue unchanged. These workflow
paths are executed by the same regression suite; they are not live retry proof.

The namespaced `jarvis-pr-maintenance/review` status must be required by the
effective `main` protection policy for Claude/Codex work. It never impersonates
TypeScript, PR Evidence or CodeQL checks and cannot satisfy the owner or existing
ToolAction approval boundary. Blocked results retain their linked run. A passing
status means only that the exact candidate reached `awaiting-owner` with trusted
green CI and a clean bounded review.

Manual entry: Actions → **Jarvis PR maintenance** → Run workflow on `main`, mode
`sweep`; optionally specify a PR number. Exact review dispatch fields are normally
filled by the coordinator. A repository writer is required for manual entry.

## Activation and proof

The workflow activates only after the reviewed control-plane change lands on
`main`. It uses the existing `OPENAI_API_KEY` Actions secret; the reviewer receives
no Convex or deployment credentials. Required GitHub job permissions are declared
in the workflow. Unavailable credentials/permissions remain explicit failures.

Before calling the handover operational, observe a real generated candidate
through review → a naturally occurring repairable finding → bounded repair on the same
PR → exact-candidate CI → fresh review → owner gate. Observe the run IDs, candidate
SHAs, unchanged forbidden files and finite attempt count. Local mock-API tests
prove admission and refusal paths, not that this live drill has happened. If no
repairable finding occurs, record the repair demonstration as unproven; never
insert a defect to manufacture it.

The scoped [issue #493 owner handoff](issue-493-owner-handoff.md) records control
landing order, evidence and recovery boundaries after the post-merge #491 review.

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
and its exact `CONVEX_URL=https://<name>.convex.cloud`, plus the existing matching
`JARVIS_SERVICE_TOKEN` secret. Ordinary approved Development admission uses the
owner-approved standing uncertainty budget `0.05`. An issue-specific repository
variable `JARVIS_DEVELOPMENT_UNCERTAINTY_BUDGET_<issue-number>` may override that
default when the owner deliberately assigns a different bounded budget. Missing
issue-specific configuration no longer blocks an ordinary approved mission.
Independent post-merge proof still requires the separate `JARVIS_APPROVAL_TOKEN`
secret and explicit operator judgement in
`JARVIS_DEVELOPMENT_RESIDUAL_UNCERTAINTY`. The GitHub observer uses the workflow's
read-only token. Owner execution still uses the authorised runtime's GitHub token
and approval path.

The `developmentWorkerClaims` functions must be deployed to that named
development deployment before activation. No production deployment is part
of this change. Missing required runtime configuration still blocks admission
instead of falling back to an untracked build.

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

### GitHub merge observation compatibility

The maintained client requests PR details with API version `2022-11-28`: GitHub
removed `merge_commit_sha` from PR responses in `2026-03-10`. Other requests keep
the current version. Completion still requires an actual provider merge SHA,
the exact reviewed head, the succeeded governed receipt and trusted main checks.
A missing SHA is inconclusive evidence, never permission to infer a merge or
replay it. See [GitHub breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes).

Completion does not use its own observer job as build evidence. Only the exact
`observe` job from the authenticated `jarvis-development-completion.yml` workflow,
bound to the observed commit, main branch and a declared trigger, is excluded
from additional failed checks. Required build/security checks and every unrelated
failure still block completion. Earlier inconclusive proofs and failed workflow
runs remain intact.

### Documentation context within review segments

The existing context resolver recognizes explicit repository-local paths in
Markdown, including relative links and paths in command/code examples. It
resolves only a unique match in the already fetched changed-file inventory,
considering the repository root and the document directory. Before and after
references both contribute context. External URLs, absolute paths, backslashes,
encoded/query paths, absent files and ambiguous matches are not resolved; bare
filenames are not guessed. No URL fetch or additional filesystem read is added.

A documentation segment can seed its linked implementation and adjacent imports.
Documentation does not become a reverse graph bridge that brings unrelated
code into implementation segments. Supplemental bytes retain their exact source
references; primary coverage and authorized finding locations are unchanged.
Existing prompt/segment limits and explicit unavailable-context records still
apply. A model's essential context request still blocks the aggregate review.
This improvement does not itself supply a Jarvis PASS to a blocked candidate.
