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

- the issues it covers and the exact commit it is about (`subject.sha`);
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
2. The card's digest. The digest covers every field of the card, including the
   commit, environment and expiry. If the card changed after it was displayed,
   the click is refused as stale.
3. Expiry, missing prerequisites and dependencies, for an approval.
4. For a high-risk card (production deployment, remote exposure, hardware
   actuation, destructive action, customer-facing send): a typed confirmation
   of the form `APPROVE <card id>`. There is no approve-all.
5. The idempotency key. A double click repeats the same key and returns the
   first record; nothing is written twice. A second, different decision on a
   settled card is refused.

A decision recorded against an old version of a card stops applying when the
card changes. The page shows how many such earlier decisions exist.

## Audit trail

Records are appended to `jarvis-owner-decisions.jsonl` in the Jarvis data
directory, one JSON object per line, mode `0600`. Each record carries the card
digest, the commit, the environment, who decided, the time, and the hash of the
record before it. The chain is verified on every read. If it does not verify,
the queue goes read-only, shows no recorded decisions and records nothing.

Limits to know:

- The ledger is written by the one HTTP process. Do not point two running
  instances at the same data directory.
- The file is not yet part of archive v4. Back it up alongside the archive.
- Without a live probe the server checks a click against the manifest, not
  against GitHub. The page says which check is in force. If a pull request
  moves after its card was written, update the manifest.

## Read-only fallback

The queue can always be read on loopback without a token. It is read-only, with
the reason shown at the top, when no approval token is configured, when the
ledger fails its integrity check, or when the tokens have not been typed in.
The tokens stay in the page's fields until you leave it and are never written
to browser storage.

## HTTP

| Route                                                  | Purpose                    | Auth                                             |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------ |
| `GET /settings/owner-decisions`                        | The page shell             | Loopback only, no token                          |
| `GET /api/v1/owner-decisions`                          | Read the queue             | None on loopback; service token off it           |
| `POST /api/v1/owner-decisions/{decisionId}/decisions`  | Record a decision          | Service token or OIDC owner, plus approval token |
| `POST /api/v1/owner-decisions/{decisionId}/executions` | Report an execution result | Service token or OIDC owner                      |
