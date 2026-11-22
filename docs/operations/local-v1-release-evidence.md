# Jarvis Local V1 release evidence ledger

**Tracker:** #697. **Runbook:** `docs/operations/local-v1-commissioning-runbook.md`.
**Release plan:** `docs/operations/local-v1-release-plan.md`.
**Owner card:** `local-v1-release` in `typescript/src/ownerGate/ownerDecisionManifest.json`.
**Reconciled against:** `main` at `5032d7fd` and the live owner-decision queue (22 Nov 2026).

This ledger maps each item in #697's definition of done to its evidence: where
it is recorded, the commit it was proven on, and what is still missing. It fills
the release card's "release evidence is not recorded" prerequisite. It does not
make the release decision. Designating a candidate **JARVIS LOCAL V1** is the
owner's decision alone (runbook Stage 10).

The ledger only records references: comment ids, PR numbers, commit SHAs and
host file paths. Raw host output, secrets and customer-shaped data stay in the
out-of-repo evidence log described at the top of the runbook.

Evidence proven on an earlier commit is **not** evidence for the release
candidate. Stage 10 re-runs the code gates on the frozen SHA, and the
"Re-prove on the candidate" column lists what has to be repeated or read again.

## Status key

- **Proven:** evidence exists and, where an owner decision applies, it is approved.
- **Ready for decision:** evidence exists and its owner card has no missing
  prerequisites, but the owner has not approved it yet.
- **Partial:** some evidence exists, but on an older commit or for only part of the item.
- **Not started:** no evidence yet.

## Definition of done

| #   | Item (#697)                                            | Status          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Re-prove on the candidate                                                                                                                         |
| --- | ------------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One known-good local runtime locked and verified       | Partial         | Runtime identity proof on `cd7b613a` with `dev:outgoing-ram-798` (#697 comment 6759238382, 10 Nov). The isolated deploy of `28d35737` passed (#697 comment 7027465234, 20 Nov).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Yes. Lock the candidate on the host, redeploy Convex dev from it (see blocker B1) and record `sourceVersion` and `deploymentVersion` from status. |
| 2   | Maintained checks and OpenAPI lint pass                | Proven (ticked) | Required checks run on every merge to `main`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Yes. Run `npm run check` and OpenAPI lint on the frozen SHA (runbook Stage 1).                                                                    |
| 3   | HUD and MCP usable against dev persistence             | Partial         | HUD snapshot and real MCP smoke against Convex dev on `cd7b613a` (#697 comment 6759238382).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Yes. Repeat runbook Stage 2b on the candidate.                                                                                                    |
| 4   | #567 guarded voice commissioning passes                | Proven          | Spoken run on the Lenovo, 13 Nov (#567 comment 6851388839), and its fix #809. Owner card `voice-host-commissioning` approved and executed. #567 closed as commissioned (#567 comment 7063052190).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Read only. Confirm the candidate contains #809.                                                                                                   |
| 5   | Voice read queries return authoritative data           | Proven (ticked) | #704 and later voice PRs, covered by merged tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | No, beyond the item 2 checks.                                                                                                                     |
| 6   | Safe voice writes reuse existing paths                 | Proven (ticked) | #714 and later voice PRs, covered by merged tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | No, beyond the item 2 checks.                                                                                                                     |
| 7   | #294 and #297 satisfied by one non-customer run        | Proven          | Traced commissioning run on `56280fa9` (#869 comment 7065797361), the ledger history and immutable-id confirmation (#873), and the evidence kit (#867). Card `outlook-evidence-acceptance` (#874) approved and executed.                                                                                                                                                                                                                                                                                                                                                                                                                                             | No, unless the candidate changes the quote send or reconciliation path.                                                                           |
| 8   | One complete Beez Treez workflow end to end            | Proven          | `commission:beez-treez-workflow` on merged `b11f1a4f`: all 14 checks, `workflow.proven: true`, with one send to the owner's own mailbox (#869 comment 7066902191). Kit merged in #875 and recorded on the release card in #876.                                                                                                                                                                                                                                                                                                                                                                                                                                      | Optional. Re-run only if the candidate changes the workflow path.                                                                                 |
| 9   | Home records and the Google Home announcement path     | Partial         | Live task/reminder/errand persistence and restart readback on `cd7b613a` (#697 comment 6761875450). Card `google-home-announcement` approved. On 22 Nov the speaker chosen in #869 comment 7063313389 was pinned and ToolAction `ghome-commission-20261122-1` (project `nolan-voice`) was approved and executed once. Receipt `8284344821107a8da607e73fb6638437` is `indeterminate`: the owner heard the Hub's music stop, but no announcement played. A second action after #879, `ghome-commission-20261122-2` (receipt `07fae9d6a2065771f4a981caef48a37f`), ended the same way. Both took about 5.3 s, and the card records both as `indeterminate` (blocker B2). | Yes. Fix B2, then stage, approve and execute one new announcement and report the result on the card.                                              |
| 10  | Workshop records usable as the daily surface           | Partial         | Live workshop build, build-log, upgrade and asset proof with restart readback on `cd7b613a` (#697 comment 6760915728).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Light. Re-read through MCP or the HUD on the candidate during the dogfood pass.                                                                   |
| 11  | Dataset recoverable through isolated restore           | Proven          | Recovery PASS on `28d35737`: capture, restore and restart, all six checks (#697 comment 7027465234). Host proof on `ca7f256f` (#865). Card `recovery-isolated-proof` approved and executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | No, unless the candidate changes the archive or restore code.                                                                                     |
| 12  | Restart preserves state; missing hardware fails closed | Partial         | The restart half is covered by item 11 and the item 9 and 10 readbacks. Fail-closed evidence: the Google Home preflight (item 9) and voice falling back to typed input with the microphone off (#567).                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Yes. Restart both services on the candidate and confirm unavailable devices report unavailable rather than success.                               |
| 13  | Integrated dogfood pass finds no release blocker       | Not started     | None yet. Use the dogfood log below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | This is a candidate-only step.                                                                                                                    |
| 14  | Independent review finds no unresolved blocker         | Not started     | None yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | This is a candidate-only step.                                                                                                                    |
| 15  | Release SHA, evidence and operator runbook recorded    | Partial         | The runbook exists. This ledger records the evidence. No release SHA is frozen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fill in the freeze record below.                                                                                                                  |

"Ticked" means the box is already checked in the #697 issue body. The other
boxes in the issue body are older than this ledger.

## Known blockers before a candidate can be frozen

- **B1: deploy Convex dev from the candidate.** On 21 Nov, the commissioning
  instance rejected `executionId` on tool-action claim because its Convex
  functions predated `79aa1776` (#866). That is no longer reproduced: the
  traced Outlook run on `56280fa9` and the 22 Nov Google Home ToolAction both
  claimed successfully. The candidate still has to be deployed to Convex dev
  from its exact SHA before items 1, 3, 9 and 12 are re-proven. Main deploys
  to Convex since #858.
- **B2: the Google Home announcement did not play.** Both 22 Nov attempts
  reached the Hub (its music stopped) and ended `indeterminate` after about
  5.3 seconds. Cause: the executor's default 5 000 ms execution limit. No
  caller passes `timeoutMs`, and an announcement (speech synthesis, connect,
  launch, load, play) takes longer. Launching the media receiver interrupted
  the music, then the executor aborted the attempt before the speech played.
  #879 records the provider's failure code on receipts. The follow-up gives
  `home:announce` and `device:announce` a 30 000 ms limit. After it merges,
  restart the service and stage one new announcement. Do not retry either
  indeterminate action.

## Known limitations to record with the release

- Archive `completeness` stays `partial` by design. Capture and restore are
  proven, but the host restart step is the only part with a single operator
  command (`commission:local-v1-recovery`).
- Totality reasoning uses the Anthropic provider (#870). Card
  `voice-model-provider-key` (`TOTALITY_REASONER_PROVIDER=anthropic`) is
  approved and executed. Voice does not depend on it.
- Physical machinery control is out of scope (V1.1). Remote exposure (#306),
  production operations (#307) and durable orchestration (#324) come after
  Local V1. TypeScript 7 (#561) is blocked upstream.

## Dogfood log (item 13)

Record each time Jarvis had to be bypassed during the dogfood pass (runbook
Stage 9). A bypass that keeps recurring is a release blocker until it is
repaired or removed from V1 scope.

| Date | Area (business / home / workshop / voice / HUD) | What was bypassed and why | Blocker? | Resolution |
| ---- | ----------------------------------------------- | ------------------------- | -------- | ---------- |
|      |                                                 |                           |          |            |

## Freeze record (items 14 and 15)

Fill this in once, for the one candidate SHA.

- **Candidate SHA:**
- **Convex dev deployment redeployed from the candidate (B1):**
- **Stage 1 checks and OpenAPI lint run:**
- **Items 1, 3, 9 and 12 re-proven (comment ids):**
- **Dogfood pass completed, with no open blocker:**
- **Independent review (who, where, verdict):**
- **Owner designation as JARVIS LOCAL V1 (date, card ledger entry):**
