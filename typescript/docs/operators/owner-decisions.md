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

## First-time setup on a runtime

Nothing can be recorded until the runtime has an approval token and a started
ledger. Both steps are the owner's; neither is done by an agent.

### 1. Configure the approval token

The HTTP process reads `JARVIS_APPROVAL_TOKEN` from its environment (on the Lenovo,
`typescript/.env.local`, which is git-ignored and mode 0600). Rules enforced by
`src/http/config.ts`: at least 32 characters, no whitespace. It must be a
different secret from `JARVIS_SERVICE_TOKEN`.

This is the **same** approval secret that governed ToolAction approvals use
(`tool-action-approval.md`). When `PERSISTENCE_PROVIDER=convex`, the Convex
deployment holds its own copy and verifies it independently, so:

- if an approval token already exists for this deployment, put that same value in
  `.env.local`; do not invent a second one, or ToolAction approvals over HTTP
  would be refused by Convex;
- if none exists yet, generate one and set it in both places.

Configuring it on the HTTP process has an effect beyond this queue: the ToolAction
approve and revoke routes (`POST .../tool-actions/{actionId}/approve` and
`.../revoke`) stop failing at their missing-token check. Each still requires the
token on the request, and the ToolAction state rules and Convex's own verification
are unchanged.

The block below adds the token without the value appearing on screen, in shell
history, in the process list or in a log. It refuses to add a second entry, checks
the length, ends the file with a newline first, stores the value single-quoted (so
the systemd `EnvironmentFile` reader and Node's `.env` reader both take it
literally), and then confirms that the value the runtime will load is the value
you entered, comparing digests only. It restarts nothing: restart the service
yourself only after it prints "Stored and verified".

```sh
( set -eu
  cd ~/Jarvis/typescript
  chmod 600 .env.local
  if grep -q '^JARVIS_APPROVAL_TOKEN=' .env.local; then
    echo "Already set. Edit that one line in an editor; do not add a second."; exit 1
  fi
  read -rs -p "Approval token (press Enter to generate a new one): " T; echo
  [ -n "$T" ] || T=$(openssl rand -hex 32)
  case "$T" in *[!A-Za-z0-9._~+/=-]*)
    echo "Refused: this block only handles letters, digits and . _ ~ + / = -"; exit 1 ;;
  esac
  [ "${#T}" -ge 32 ] || { echo "Refused: shorter than 32 characters."; exit 1; }
  [ -z "$(tail -c1 .env.local)" ] || echo >> .env.local
  printf "JARVIS_APPROVAL_TOKEN='%s'\n" "$T" >> .env.local
  WANT=$(printf %s "$T" | sha256sum | cut -d' ' -f1)
  GOT=$(node --env-file=.env.local -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.JARVIS_APPROVAL_TOKEN ?? "").digest("hex"))')
  [ "$WANT" = "$GOT" ] || { echo "Mismatch: fix .env.local before restarting."; exit 1; }
  echo "Stored and verified. Now run: systemctl --user restart jarvis.service"
)
```

An existing token that contains other characters (for example `#` or `$`) is still
valid for Jarvis, but an unquoted `#` starts a comment in a `.env` file and would
silently shorten it. Add such a token by hand in an editor, as one line
`JARVIS_APPROVAL_TOKEN='...'` (single-quoted; this does not work for a token that
itself contains a single quote), then confirm what the runtime will load with this
separate check. It asks for the token again at a hidden prompt and compares
digests only:

```sh
( set -eu
  cd ~/Jarvis/typescript
  chmod 600 .env.local
  [ "$(grep -c '^JARVIS_APPROVAL_TOKEN=' .env.local)" = 1 ] || { echo "Expected exactly one entry."; exit 1; }
  read -rs -p "Approval token, to compare: " T; echo
  WANT=$(printf %s "$T" | sha256sum | cut -d' ' -f1)
  GOT=$(node --env-file=.env.local -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.JARVIS_APPROVAL_TOKEN ?? "").digest("hex"))')
  [ "$WANT" = "$GOT" ] || { echo "Mismatch: fix .env.local before restarting."; exit 1; }
  echo "Verified. Now run: systemctl --user restart jarvis.service"
)
```

A generated token then has to be copied once into a password manager, because the
page asks for it on every decision: open `.env.local` in an editor to read it; do
not `cat` it into a terminal that is being recorded or shared. Never commit it,
paste it into an issue or chat, or give it to an agent. If the token is new, set
the same value in the Convex deployment too.

Check: `/settings/owner-decisions` no longer gives "No approval token is
configured on this runtime" as the reason the queue is read-only. Until the ledger
is started it will give the missing ledger as the reason instead.

### 2. Start the ledger

On the page, use "Start a new ledger": the service token, the approval token and
the typed phrase `START NEW LEDGER`. Do this once per runtime, and only if there is
genuinely no earlier ledger to restore (see "Starting the ledger, and restoring a
backup" below).

## The manifest

The cards come from `src/ownerGate/ownerDecisionManifest.json`, a reviewed file
in the repository. Changing a card means changing that file through a pull
request. Each entry names:

- the issues it covers and its `subjects`: each pull request or branch pinned to
  an exact commit, and each issue pinned to its last-updated time, so a new
  comment or edit on the issue (new evidence, a changed requirement) makes the
  card stale;
- the proposed action, consequence, scope, environment and how to undo it;
- `evidence`: each piece of proof as a label and a pin (an issue, a pull
  request, or a specific comment with its last-updated time). The link shown on
  the card is derived from the pin. A card with no evidence is `NOT_READY`;
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
5. For an approval, every subject and every piece of evidence live against
   GitHub: the pull request head, the issue's or comment's last-updated time,
   the branch head. If any has changed the approval is refused; if any cannot
   be checked (deleted evidence, a comment that is not on the pinned issue or pull
   request, GitHub unreachable, rate limited) the approval
   is also refused. Reject and Request changes do not need the live check.
6. The idempotency key. A double click repeats the same key and returns the
   first record; nothing is written twice. A second, different decision on a
   settled card is refused.

An approval can be withdrawn with Reject or Request changes until it is
executed, with one exception: while an execution is reported `indeterminate`
the approval cannot be withdrawn, because the work may already have happened.
Report the real outcome first. An execution report stays on the card after a
later rejection. An `indeterminate` execution can still be resolved to
`executed` or `failed` after the request has expired; nothing else can be
recorded against an expired approval.

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
is what a crash between the append and the checkpoint write leaves behind. The
next write brings the checkpoint level before appending, so repeated crashes
cannot leave it further behind. An empty ledger file with no checkpoint is a
start that was interrupted; "Start a new ledger" completes it.

Before each append the ledger is read and verified again, and the new record
must extend exactly that verified tail. If the file changed while a click was
being checked, the click fails, nothing is appended and the checkpoint is not
moved.

### Starting the ledger, and restoring a backup

A runtime with neither file has no ledger, and nothing can be recorded. The
page offers "Start a new ledger", which needs both tokens and the typed
confirmation `START NEW LEDGER`.

This is deliberate. A new Local V1 capture records whether the ledger was
present or absent. When present, it copies the exact ledger and checkpoint bytes
into the capture directory and binds their SHA-256 digests and ledger record
count into `archive.json`. Verification checks those values, the hash chain and
the checkpoint. The capture caller supplies the ledger directory explicitly;
the runtime uses `JARVIS_DATA_DIR` through `jarvisDataFile`, independently of
the clients register location. The isolated proof accepts later source appends
when the captured ledger remains an exact byte prefix and the restored files
match the capture. A Local V1 restore writes both files with mode `0600` into its
new isolated JSON directory only when neither target file exists. It refuses
an existing ledger or checkpoint and never merges histories. An absent capture
restores neither file, so the queue remains unstarted until the owner explicitly
starts it. Older archives without the ledger section report `not-captured`;
restore the two files separately before using their decisions.

The restore writes the checkpoint before the ledger. If it stops between those
writes, the queue treats the checkpoint-only state as damaged, never as a valid
empty or shorter decision history. Preserve and inspect an interrupted restore;
use a fresh isolated destination for a retry.

Keep both source files together with any older archive. A capture does not
include decisions recorded after its capture time, the approval token, any
service token, or the reviewed decision-card manifest from a later code version.

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
