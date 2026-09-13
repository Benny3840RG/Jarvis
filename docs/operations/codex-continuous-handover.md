# Codex continuous-work handover

Use this handover when starting or resuming Codex work on Jarvis.

## Standing instruction

Work on the existing repository at `Benny3840RG/Jarvis`. Do not restart,
redesign or replace Jarvis. Read and obey:

1. `AGENTS.md`;
2. `docs/operations/dual-agent-coordination.md`;
3. `typescript/docs/ROADMAP.md`;
4. the runbooks relevant to the assigned issue.

The coordination protocol is mandatory. It prevents Codex and Claude from
editing the same mission.

## Rotation

For the first mission after the coordination protocol is adopted:

- Codex is the **builder**.
- Claude is the **independent reviewer**.

After Benny makes that mission terminal, roles flip. Do not infer a flip from a
new chat, interrupted session, pushed commit, review, green CI or draft PR.
Read the current mission's `AGENT COORDINATION v1` block on GitHub.

If Codex is not explicitly named as the current builder or reviewer, perform no
repository write.

## Codex as builder

1. Confirm the mission was explicitly assigned by Benny and does not overlap an
   autonomous worker, open PR, active branch or another claimed mission.
2. Record or verify the coordination block, exact `main` base and scoped branch.
3. Use a dedicated worktree or clean checkout. Never work directly on `main`.
4. Reproduce the defect or missing behaviour.
5. Add the smallest failing regression first for non-trivial work.
6. Update OpenAPI first for HTTP, MCP or operator-contract changes.
7. Implement the minimum safe fix. Avoid unrelated refactors.
8. Preserve provider parity, stored-data compatibility and backup/restore
   behaviour. Fail closed when evidence or authority is missing.
9. Run `npm run check` from `typescript/`; run the additional contract or
   authorised development-only Convex checks required by `AGENTS.md`.
10. Commit coherent, reviewable steps and open or update one draft PR.
11. Hand Claude the exact candidate SHA and the complete builder handoff from
    the coordination protocol.
12. Apply validated review repairs on the same branch, rerun all affected
    checks, and request a fresh review of the new exact head.

Codex must not review its own work, mark the PR ready, submit an approval, merge,
deploy, close an issue or weaken a gate.

## Codex as reviewer

Remain read-only for the entire mission.

1. Wait for Claude's exact candidate SHA and complete builder handoff.
2. Inspect the issue contract, full diff and relevant unchanged context from a
   fresh checkout.
3. Verify scope, test intent, correctness, failure handling, security, provider
   parity, persisted-state compatibility and operational claims.
4. Separate reproducible defects from stale, duplicate, speculative or
   already-fixed findings.
5. Run independent checks when practical without editing or pushing.
6. Return the reviewer handoff defined in the coordination protocol.
7. If repair is required, give Claude the smallest reproducible repair target.
   Review the repaired exact head afresh.
8. If clean, state `OWNER DECISION REQUIRED`. Do not formally approve, mark
   ready, merge or deploy.

## Required end-of-session report

Always report:

- mission and current role;
- inspected base and candidate SHAs;
- files changed, or `read-only review—no files changed`;
- exact checks run and their results;
- real blockers and unverified external claims;
- current builder/reviewer handoff state;
- next bounded action;
- `Merge authorised: NO`;
- `Deployment authorised: NO`.

Do not claim production, commissioning, recovery or deployment evidence from
tests or documentation alone. Credentials, external systems and exact-release
owner decisions remain separate gates.
