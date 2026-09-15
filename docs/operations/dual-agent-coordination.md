# Claude and Codex coordination protocol

This protocol governs continuous manual agent work on Jarvis. It supplements
`AGENTS.md` and the maintained runbooks. If instructions conflict, the stricter
safety or authority boundary wins.

It grants no production, merge, approval, deployment, secret-handling or issue
closure authority.

## Operating model

Jarvis uses one active implementation mission at a time:

1. One agent is the **builder**.
2. The other agent is the **independent reviewer**.
3. Jarvis independently gates the exact reviewed candidate after the peer review.
4. The roles flip only after the mission is terminal: Benny merges or closes the
   draft PR, or explicitly abandons the mission.
5. The first mission after this protocol is adopted assigns **Codex as builder**
   and **Claude as reviewer**. The next mission reverses those roles.
6. A restarted session does not advance the rotation.

The reviewer remains read-only for that mission. It does not repair the
candidate
it reviews. The builder owns all candidate changes until Benny makes the terminal
decision.

## Authority boundary

Both agents may:

- inspect the repository, issues, workflow runs and existing evidence;
- create a mission branch and draft PR when acting as builder;
- push bounded commits to that mission branch;
- run development tests and checks;
- leave factual coordination or review comments that grant no authority.

Neither agent may:

- merge, squash, rebase-merge, enable auto-merge or mark a draft PR ready;
- approve its own or the other agent's PR through a formal approval review;
- deploy, commission or expose a hosted or production runtime;
- use production credentials or move secrets into chat, logs, issues or commits;
- close or reopen issues, alter issue/PR labels, or declare an external gate
  complete;
- weaken tests, checks, branch protection, review policy or owner gates to make a
  candidate pass.

Every merge and deployment requires a fresh, explicit decision from Benny
against the exact candidate or release.

Jarvis supplies a required machine gate, not owner approval. A candidate is not
eligible for Benny's merge decision until the exact head has all required trusted
CI and a successful `jarvis-pr-maintenance/review` status. Missing, pending,
failed, stale or differently bound evidence blocks. A new commit or base change
invalidates the prior peer review and Jarvis PASS.

## Source of truth and mission claim

GitHub is the coordination record. Chat memory is not.

Before any edit, the builder must inspect:

- current `main` and its exact SHA;
- open PRs and active GitHub Actions runs;
- the selected issue, its complete comments and acceptance criteria;
- `AGENTS.md`, `typescript/docs/ROADMAP.md` and relevant runbooks;
- the existing autonomous-build queue and mission lock.

Do not manually claim an issue carrying `automation-approved`,
`automation-in-progress` or `automation-blocked`, or an issue already
represented by an open branch, PR or active worker. Those belong to the
maintained autonomous pipeline unless Benny explicitly removes or reassigns
them.

The mission issue must contain an explicit Benny instruction assigning it to
this dual-agent process. The builder records this block before editing:

```text
AGENT COORDINATION v1
Mission: #<issue>
Rotation: <number>
Builder: <Claude|Codex>
Reviewer: <Claude|Codex>
Base: <full main SHA>
Branch: agent/issue-<number>-<slug>
Scope: <files or subsystem>
State: CLAIMED
Owner authority: draft PR only; merge and deployment withheld
```

If the block is missing, contradictory, stale, or names a different active
builder, stop. Do not infer ownership.

## Collision prevention

- Use a dedicated worktree or clean checkout and one branch:
  `agent/issue-<number>-<slug>`.
- Never edit directly on `main`.
- One issue maps to one implementation branch and one draft PR.
- The reviewer never pushes to, rebases or repairs the builder's branch.
- The builder does not start a second mission while its current draft PR is
  open.
- Do not make drive-by refactors or fixes outside the recorded scope. Record a
  separate follow-up instead.
- Before every push, fetch remote state and verify the expected branch, base and
  head. Unexpected movement, foreign commits, dirty files or overlapping scope
  is a stop condition.
- If `main` advances, do not silently rebase. Finish the current bounded step,
  report the new base, and integrate only when the mission contract and evidence
  can be revalidated.
- Never use force-push for a shared or reviewed candidate.

## Builder procedure

1. Reproduce the gap and define the smallest observable acceptance test.
2. For non-trivial behaviour, add a failing test before implementation.
3. For HTTP, MCP or operator-visible contract changes, update
   `typescript/openapi/jarvis.openapi.json` first.
4. Implement the minimum scoped change.
5. Update affected documentation and backup/restore compatibility when behaviour
   or persisted state changes.
6. Run from `typescript/`:
   - `npm run check`;
   - `npm run openapi:lint` when the API contract changes;
   - `npm run smoke:convex` only against an authorised `dev:` deployment when Convex behaviour changes.
7. Commit small coherent steps. Record exact commands and results.
8. Push the branch and open or update one **draft** PR.
9. Hand the exact head SHA, diff scope, test evidence, known limitations and
   unresolved risks to the reviewer.

Green tests do not prove live commissioning, production safety or completion of
an external gate.

## Reviewer procedure

The reviewer starts only after the builder supplies an exact head SHA.

1. Inspect the issue contract, base SHA, complete diff and relevant unchanged
   context.
2. Verify the candidate is the supplied head and contains no unrelated or
   forbidden changes.
3. Check correctness, security, failure behaviour, backward compatibility,
   provider parity, persistence and backup/restore impact.
4. Verify tests exercise the claimed behaviour and fail for the intended reason;
   distinguish real defects from stale, duplicate or unsupported findings.
5. Run appropriate checks from a fresh read-only checkout when practical.
6. Report findings with severity, file/range, reproduction and smallest repair.
7. If clean, report **review complete—owner decision required**. Do not submit a
   GitHub approval or mark the PR ready.
8. If defects exist, hand them back to the same builder. Review the repaired
   exact head again; old review evidence does not transfer.

A reviewer must block rather than guess when essential context, provenance or
test evidence is unavailable.

## Jarvis gate

After the peer reviewer reports a clean exact head, Jarvis must independently
observe that same candidate through `jarvis-pr-maintenance`:

1. Re-read the PR number, base SHA, head SHA and complete required-check evidence.
2. Accept only trusted successful TypeScript, PR Evidence and CodeQL producers.
3. Run the isolated read-only review and bind its result to the exact candidate.
4. Publish `jarvis-pr-maintenance/review = success` only for a clean review and
   trusted green CI.
5. Publish failure or remain non-success for missing context, real findings,
   untrusted evidence, stale identity or incomplete execution.

The Jarvis PASS must be a required `main` merge status. It does not approve,
merge, deploy, commission, close an issue or satisfy Omega evidence. Only Benny
may act after the gate passes.

This operating model is not enforced merely because this document is merged.
Activation requires live GitHub protection for `main` that names the Jarvis
status as a required check, followed by API readback and an ordinary-PR refusal
and success drill. Until that evidence exists, treat the gate as configured but
unenforced.

## Handoff format

Each builder-to-reviewer handoff must include:

```text
Mission: #<issue>
Builder / reviewer:
Base SHA:
Candidate SHA:
Draft PR:
Scope changed:
Acceptance criteria addressed:
Tests and exact results:
External/live proof performed:
External/live proof not performed:
Known risks or limitations:
Owner decisions still required:
```

Each reviewer-to-builder or reviewer-to-owner handoff must include:

```text
Reviewed candidate SHA:
Verdict: BLOCKED | REPAIR REQUIRED | OWNER DECISION REQUIRED
Real findings:
Stale/unsupported findings:
Checks independently observed:
Required smallest repair:
Merge authorised: NO
Deployment authorised: NO
```

`OWNER DECISION REQUIRED` is valid only when the exact reviewed candidate also
has `jarvis-pr-maintenance/review = success`. Otherwise the verdict remains
`BLOCKED` or `REPAIR REQUIRED`.

## Terminal transition

Only Benny can make the mission terminal by merging, closing or explicitly
abandoning it. After that decision:

1. Record the terminal PR state and exact merge SHA or closed head.
2. Record what evidence remains incomplete; do not rewrite failed history.
3. Flip builder and reviewer for the next mission.
4. Select no new mission that overlaps an active autonomous worker or unresolved
   recovery/production gate.
5. Begin again from a freshly inspected `main`.

This protocol coordinates work. It does not replace Jarvis's existing
autonomous queue, exact-head verification, independent review, durable evidence
or owner approval controls.
