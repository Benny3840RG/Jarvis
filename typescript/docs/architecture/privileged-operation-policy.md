# Privileged operation policy (#839, first slice)

`src/security/privilegedOperationPolicy.ts` is the deny-by-default policy
NOLAN's trusted autonomy will run behind. It **decides and never executes**.
This slice has no broker, no root process, no shell, and no service, network
or security-scan call, and nothing calls it in production yet.

## Authority sits outside the model

- **Closed catalogue.** The operations are `service.status`, `service.restart`,
  `package.install`, `firewall.change`, `protected_file.write` and
  `maintenance.session`. Each has a strict schema with no raw shell strings. An
  operation's tier comes from the code, never from the request. Unknown,
  shell-shaped and prototype names (`__proto__`, `toString`) are refused.
- **Service allowlist.** Only `jarvis.service` can be inspected or restarted.
- **Three tiers:**
  - `read`: `service.status` needs no grant, and stays available during a halt.
  - `standing_grant`: `service.restart` needs an owner-issued grant that is
    scoped to the operation and service, already issued, unexpired and within
    `maxUses`.
  - `owner_approval`: every other operation needs a ToolAction that is
    `approved` by the user, single-use and unexpired (by flag or by
    `approvalExpiresAt`), for `privileged/<operation>`, with canonically
    identical arguments, issued for this exact request ID. Standing grants never apply here, so they cannot
    escalate.

## Verified recovery, not blind retry

A restart also needs:

- an `unhealthy` observation of that service, no more than 60 seconds old
  (unknown, missing, stale or future-dated health is refused);
- fewer than three restart attempts in the last hour. Future-dated attempts
  count, so clock skew cannot reopen the budget.

The caller must supply the grant use count and restart history. Missing values
give `invalid_context`; they are never assumed to be zero.

## Halt and replay

Any halt state (`requested`, `acknowledged`, `verified_stopped`) blocks every
non-read operation. A request ID that has already been decided is refused as
`replayed_request`.

## Decision binding

An allowed decision carries `bindingDigest`, a SHA-256 hash over the policy
version, request ID, operation, parsed arguments and authority reference. A
future broker must act on exactly that decision.

`protected_file.write` paths must be absolute and normalised (no `.` or `..`
segments, doubled or trailing slashes, or NUL). Symlinks can't be resolved by a
pure function, so the broker must resolve the real path itself and refuse if it
differs from the approved path.

## Guardian status reader

`src/security/guardianServiceStatus.ts` produces the health observation that a
restart needs. It runs one fixed command, `/usr/bin/systemctl --user show
<unit> --property=LoadState,ActiveState,SubState,NRestarts --no-pager`, through
`execFile` with no shell, a 3-second timeout, 4 KB of output and a minimal
environment. The unit must be on the code allowlist; anything else is refused
before a process starts. `jarvis.service` is a user unit, so this needs no root.

It only reports `unhealthy` for a `failed` unit or one stuck in
`activating/auto-restart`. A stopped (`inactive`) or changing unit is
`unknown`, so a deliberate stop is never "repaired". Errors, timeouts, a unit
that isn't loaded, and duplicate, missing or malformed properties are all
`unknown`. `observedAt` is taken after the read completes. Nothing calls the
reader in production yet, and it never restarts anything.

## Not in this slice

The root broker (Unix socket, peer credentials), allowlisted log excerpts,
investigate and redteam modes, `nolan sec halt` propagation, and grant and
replay persistence. Each needs separate review, owner approval and
commissioning before it gets any production privilege.
