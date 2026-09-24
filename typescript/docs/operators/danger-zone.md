# Settings → Danger zone

Danger zone is the canonical home for operator actions that revoke a previous
credential, quarantine local JSON, or interrupt running clients. Credentials may
link to the same cards. It does not define a second confirmation or a softer
recovery than the CLI and runbooks.

The page is loopback `GET /settings/danger`. `GET /api/v1/settings/danger-zone/page`
renders the same HTML. The read model is `GET /api/v1/settings/danger-zone`. A
confirmed action is `POST /api/v1/settings/danger-zone/actions/{actionId}` with
the bearer service token. The page keeps that token in the field for the
request only and does not write it to sessionStorage. Cancel is the default
focused control. The confirmation string is a case-sensitive exact match.
Credentials links here and does not execute End. Backup is a link to Persistence
Backup (`/settings/persistence#backup`); this page does not export an archive.

## CLI / runbook parity

| UI                   | Operator analogue                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| End service overlap  | `npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS`                                                         |
| End approval overlap | `npx convex env remove JARVIS_APPROVAL_TOKEN_PREVIOUS`                                                        |
| End delivery overlap | `npx convex env remove JARVIS_DELIVERY_RUNTIME_TOKEN_PREVIOUS`                                                |
| Reset local JSON     | Quarantine `typescript/data/jarvis-state.json` with the runtime `.corrupt-*` rename. Convex is not modified.  |
| Clear local          | Quarantine the local core, memory, and business JSON files with `.corrupt-*` renames. Convex is not modified. |
| Safer prelude        | `npm run backup -- export <file>` then `npm run backup -- verify <file>`                                      |

Each dialog states what is affected, then requires an exact typed confirmation. End overlap revokes the previous variable immediately. There is no grace period and no second End path on Credentials. The service token is sent once and cleared. It is not returned, logged, or shown again. Phase A does not wipe Convex owner data.

Confirm strings, owned by Danger. Credentials does not collect them:

- `END OVERLAP`
- `END APPROVAL OVERLAP`
- `END DELIVERY OVERLAP`
- `RESET JSON`
- `CLEAR LOCAL`

End overlap is disabled when that previous variable is unset (`No previous token accepted.`).
The delivery card stays visible and disabled when `JARVIS_DELIVERY_RUNTIME_TOKEN` is absent.
A failed Convex removal leaves the previous variable in place. Local `.env.local` is updated
only after the Convex removal succeeds. Restart local processes after a removal; a process
keeps the environment it started with.

Reset JSON quarantines `jarvis-state.json` only. Clear local quarantines the core, memory,
and business documents listed in `jarvisDataPaths.ts`. Neither action calls a Convex delete
API. A live `.lock` whose process is still running is refused with the ownership timeout
copy. A symlink that resolves outside the data directory is refused. Clear local requires a
verify receipt from the last 24 hours (`npm run backup -- verify` writes
`<file>.jarvis-verify.json`) or an explicit skip checkbox.

Phase A does not wipe Convex owner data, restore into a non-empty provider, enable the
remote gateway, change constitutional or ΩΣ settings, or run `restore-drill`.

Successful actions append a redacted line to `jarvis-operator-audit.jsonl` in the data
directory: action id, timestamp, provider, pid, and hostname. Token values are not written.
