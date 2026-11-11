# Owner decision queue

One page that lists every decision waiting on the owner, each as a card with the
plain consequence, the exact scope, the evidence and three buttons: Approve,
Request changes, Reject. Issue #801.

Open it at `/settings/owner-decisions` on a loopback bind (for example
`http://127.0.0.1:3000/settings/owner-decisions`). The Systems view of the HUD
links to it. It is not served on a non-loopback bind.

## What a click does, and does not do

A click appends one record to the audit trail saying what the owner decided.
That is all. It does not merge, deploy, send, actuate or enable anything.
ToolAction approval, CI, independent review, credentials and deployment
controls still gate the work itself. A GitHub comment or reaction is not a
decision; only a record in this ledger is.

Approval and execution are separate. After an approval, whoever carries the
work out through its own governed path reports the result with
`POST /api/v1/owner-decisions/{decisionId}/executions` (`executed`, `failed`
or `indeterminate`), and the card shows it. `indeterminate` stays visible until
a later report resolves it.

## The manifest

The cards come from `src/ownerGate/ownerDecisionManifest.json`, a reviewed file
in the repository. Changing a card means changing that file through a pull
request. Each entry names:

- the issues it covers and its `subjects`: each pull request or branch pinned to
  an exact commit, and each issue pinned to its last-updated time, so a new
  comment or edit on the issue (new evidence, a changed requirement) makes the
  card stale;
- the proposed action, consequence, scope, environment and how to undo it;
- evidence links, which must point into this repository on GitHub;
- `missingPrerequisites`: what is still missing before the owner can usefully
  decide. A card with anything here is `NOT_READY`, so missing commissioning
  evidence is never presented as waiting on the owner;
- `dependsOn`: other cards that must be approved first;
- `expiresAt`.

The manifest is validated strictly at start-up. An invalid manifest stops the
service from starting rather than showing a partial queue.

`excluded` lists open issues deliberately left out, with the reason (parked
ideas, dependency watches).

## Statuses

| Status              | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `NOT_READY`         | A prerequisite is missing or a dependency is not approved. Cannot approve. |
| `READY`             | Everything needed is present. One click decides it.                        |
| `APPROVED`          | The owner approved. Nothing has been reported as executed yet.             |
| `REJECTED`          | The owner rejected, or withdrew an approval before execution.              |
| `CHANGES_REQUESTED` | The owner asked for changes. The card must change to be decided again.     |
| `EXPIRED`           | The request passed its expiry, with or without an approval.                |
| `EXECUTED`          | An approved decision was reported as carried out.                          |

## What is checked on every click

The server re-checks all of this when the click arrives, whatever the page
showed:

1. The service token (or the OIDC owner) on the request, and separately the
   approval token (`JARVIS_APPROVAL_TOKEN`) in the body. A valid service token
   alone cannot record a decision.
2. The card's digest. The digest covers every field of the card, including its
   subjects, environment and expiry. If the card changed after it was displayed,
   the click is refused as stale.
3. Expiry, missing prerequisites and dependencies, for an approval.
4. For a high-risk card (production deployment, remote exposure, hardware
   actuation, destructive action, customer-facing send): a typed confirmation
   of the form `APPROVE <card id>`. There is no approve-all.
5. For an approval, every subject live against GitHub: the pull request head,
   the issue's last-updated time, the branch head. If any has changed the
   approval is refused; if any cannot be checked (GitHub unreachable, rate
   limited) the approval is also refused. Reject and Request changes do not
   need the live check.
6. The idempotency key. A double click repeats the same key and returns the
   first record; nothing is written twice. A second, different decision on a
   settled card is refused.

An approval can be withdrawn with Reject or Request changes until it is
executed, with one exception: while an execution is reported `indeterminate`
the approval cannot be withdrawn, because the work may already have happened.
Report the real outcome first. An execution report stays on the card after a
later rejection.

The live check reads public GitHub endpoints for the repository named in the
manifest and sends nothing but the request. Set
`JARVIS_OWNER_DECISIONS_GITHUB_TOKEN` to a read-only token if the repository is
private or the anonymous rate limit is a problem.

A decision recorded against an old version of a card stops applying when the
card changes. The page shows how many such earlier decisions exist.

## Audit trail

Records are appended to `jarvis-owner-decisions.jsonl` in the Jarvis data
directory, one JSON object per line. Each record carries the card digest, the
subject revisions, the environment, who decided, the time, and the hash of the
record before it. Beside it, `jarvis-owner-decisions.jsonl.checkpoint.json`
holds the count and hash of the last record.

Every read verifies the hash chain and the checkpoint. The queue goes
read-only, shows no recorded decisions and records nothing when:

- either file is missing while the other exists;
- the ledger is shorter than its checkpoint says (a removed or emptied tail);
- the last line is incomplete (a crash mid-write). It is refused, not repaired;
- any record or the checkpoint is unreadable or the chain does not verify;
- either file is not a regular file with mode `0600`, or is a symlink.

A ledger that is exactly one record ahead of its checkpoint is accepted: that
is what a crash between the append and the checkpoint write leaves behind.

### Starting the ledger, and restoring a backup

A runtime with neither file has no ledger, and nothing can be recorded. The
page offers "Start a new ledger", which needs both tokens and the typed
confirmation `START NEW LEDGER`.

This is deliberate. A data directory restored from a backup also has neither
file, because **archive v4 does not include the ledger**. If that runtime
started an empty ledger silently, every card would show as undecided. So after
a restore:

1. Copy `jarvis-owner-decisions.jsonl` and its `.checkpoint.json` back into the
   data directory, both mode `0600`, before opening the queue.
2. Only if there is genuinely no earlier ledger, start a new one.

Back the two files up together alongside each archive.

Other limits:

- The ledger is written by the one HTTP process. Do not point two running
  instances at the same data directory.
- Deleting both files together looks the same as a runtime that never had a
  ledger. Nothing on the host can tell those apart; keep a copy elsewhere.

## Read-only fallback

The queue can always be read on loopback without a token. Nothing can be
recorded, and the reason is shown at the top, when no approval token is
configured, when no ledger has been started, or when the ledger fails its
checks. That applies to decisions and to execution reports alike. Approvals
alone are also refused when the live check is unavailable. The tokens stay in
the page's fields until you leave it and are never written to browser storage.

## HTTP

| Route                                                  | Purpose                    | Auth                                             |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------ |
| `GET /settings/owner-decisions`                        | The page shell             | Loopback only, no token                          |
| `GET /api/v1/owner-decisions`                          | Read the queue             | None on loopback; service token off it           |
| `POST /api/v1/owner-decisions/ledger`                  | Start a new, empty ledger  | Service token or OIDC owner, plus approval token |
| `POST /api/v1/owner-decisions/{decisionId}/decisions`  | Record a decision          | Service token or OIDC owner, plus approval token |
| `POST /api/v1/owner-decisions/{decisionId}/executions` | Report an execution result | Service token or OIDC owner                      |
