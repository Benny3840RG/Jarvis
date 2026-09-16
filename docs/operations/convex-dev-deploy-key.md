# Convex dev deployment: scoped deploy-key mechanism

Status: current. Covers pushing code to the `dev:outgoing-ram-798` Convex deployment
only. This is separate from `JARVIS_SERVICE_TOKEN` (runtime app auth, see README's
"Convex persistence and service authentication") — this doc is about deploying
functions/schema, not about the running app authenticating its own users.

## Why this exists

The original ad hoc flow resolved a deployment admin key from Benny's personal Convex
access token (`~/.convex/config.json`, account-wide scope, via
`POST /api/deployment/authorize_within_current_project`) and passed it to the CLI as
`--admin-key <secret>` on argv. That works, but every deploy depended on an
account-wide credential and put the secret in process argv (visible to other local
processes via `ps`/`/proc/<pid>/cmdline`). #553 recovery replaced it with a
deployment-scoped deploy key injected only via environment.

## Mechanism

Script: `typescript/scripts/convex-deploy-dev-outgoing-ram-798.mjs`. Run from
`typescript/`:

```bash
node scripts/convex-deploy-dev-outgoing-ram-798.mjs --dry-run
node scripts/convex-deploy-dev-outgoing-ram-798.mjs --deploy
node scripts/convex-deploy-dev-outgoing-ram-798.mjs --verify
```

It locates the repo relative to its own file location (`import.meta.url`), so it works
from any checkout or worktree, not just the one it was written in.

Modes:

- `--dry-run` — non-mutating. On success, writes a single-use, git-SHA-bound approval
  receipt with a 20-minute TTL to `~/.local/state/jarvis-convex/last-dry-run-receipt.json`.
- `--deploy` — real deploy. Requires a receipt from `--dry-run` matching the current
  commit and still within its TTL; consumes (deletes) it whether or not the deploy
  itself succeeds. There is no path to a real deploy without a fresh matching receipt.
- `--verify` — non-mutating, identical dry-run diff check, no receipt written. Use
  after a real deploy to confirm the change landed (an already-applied change reports
  an empty/no-op diff).

Hardcoded, non-parameterized target: `dev`, `outgoing-ram-798`,
`https://outgoing-ram-798.convex.cloud`. Do not add a flag to redirect this script at
another deployment — copy it and change the constants instead, so a flag-parsing
mistake can never reach `prod`.

## Credential handling

- Secret file: `~/.local/state/jarvis-convex/dev-outgoing-ram-798.env` — outside any
  git repository, directory mode `0700`, file mode `0600`, single line
  `CONVEX_DEPLOY_KEY=dev:outgoing-ram-798|...`.
- Provisioned once via `deployment token create`, which needs Benny's personal token —
  this is the **only** step permitted to touch `~/.convex/config.json`:
  ```
  node node_modules/convex/bin/main.js deployment token create <name> \
    --deployment-name outgoing-ram-798 \
    --save-env ~/.local/state/jarvis-convex/dev-outgoing-ram-798.env
  ```
  `--save-env` writes the key straight to disk; the CLI never prints it, so an agent
  running this command does not see the secret value either.
- The script loads the key from that file, checks its prefix
  (`dev:outgoing-ram-798|`) and refuses anything containing `prod` before any network
  call, then injects it **only** into the Convex child process's environment as
  `CONVEX_DEPLOY_KEY` — never as a CLI argument.
- All captured child stdout/stderr is redacted (literal key value stripped) before
  being written to the console or a log file.
- Rotate by re-running `deployment token create` with a new name and the same
  `--save-env` path, then delete the old token from the Convex dashboard.

## Known limitation

This Convex CLI/API version (`1.45.0`) has no `deployment:deploy`-only permission
scope. A key from `deployment token create` can deploy, run functions, and read/write
data on that one deployment. The actual privilege reduction versus the old personal
token is the single-deployment binding, not a deploy-only role. Do not describe this
mechanism as least-privilege beyond that.

## Safety gates

- Refuses if the deployment key file is missing, empty, prefixed `prod`, or doesn't
  match `dev:outgoing-ram-798|` — before any network activity.
- Refuses if the working tree (in the checkout the script targets) is not clean.
- Refuses `--deploy` without a fresh, SHA-matched, non-expired `--dry-run` receipt —
  this is the technical form of "explicit approval between dry-run and real deploy";
  in practice an agent should still only run `--deploy` after the owner says so in
  chat, same as for any other mutating action.
- Scans all deploy output for deletion/destructive-schema signals
  (`Deleted table indexes`, `Would delete`, `removed_indexes`, schema-breaking
  language, data loss) and for the expected target URL, aborting rather than
  declaring success if anything doesn't match.

## Retired

`inspect-deployment.mjs` and `execute-deployment.mjs` (the personal-access-token /
`--admin-key` argv flow) are retired to
`~/jarvis-session-handoffs/553-recovery-evidence/deprecated-admin-key-flow/` for the
audit trail. Do not run them for new deploys.
