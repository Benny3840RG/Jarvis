# Jarvis failure behaviour

Jarvis treats persistence as authoritative. It does not silently fall back from Convex to local JSON because that would split data across providers and make recovery ambiguous.

| Failure | Required behaviour | Recovery |
|---|---|---|
| Malformed local JSON | Move the file aside with a `.corrupt-*` suffix and start from an empty document. Preserve the original bytes for inspection. | Inspect or restore from a verified backup. |
| Unsupported local document version or malformed rows | Quarantine the document rather than coercing unknown data. | Upgrade Jarvis or restore a compatible backup. |
| Invalid or missing record ID | Return “not found” and keep the interactive session alive. Do not write state. | Re-run `task list` or `reminder list` and use a current ID. |
| Missing Convex configuration | Refuse to construct the Convex provider. | Set `CONVEX_URL` and `JARVIS_SERVICE_TOKEN` locally. |
| Unauthorized Convex request | Reject the operation. Do not retry against another provider and do not include token values in errors. | Correct or rotate the service token. |
| Convex unavailable during startup | Close readline and fail before printing the ready prompt. No commands may execute against an incomplete snapshot. | Restore connectivity and restart Jarvis. |
| Convex unavailable during a command | Report `Command failed` and continue the REPL. Do not invent or cache a successful result. | Retry after connectivity returns. |
| Durable task/reminder write succeeds but runtime-state save fails | Keep the durable task/reminder result, warn that runtime state was not saved, and continue the session. | The next durable list refresh shows the authoritative record. |
| Backup restore target is non-empty | Refuse restore before creating any records. | Export the target first, then restore into a deliberately empty provider. |
| Backup restore fails after creating records | Remove records created by that restore and clear state written by it. Surface an aggregate error if rollback is incomplete. | Resolve the cause and rerun only after confirming the target is empty. |

## Automated coverage

The behaviour above is locked down across:

- `tests/persistence.test.ts`
- `tests/cli.wiring.test.ts`
- `tests/auth.helpers.test.ts`
- `tests/backup.test.ts`
- `tests/failure.behaviour.test.ts`

The guarded live Convex smoke command remains the final deployment-level check:

```bash
cd typescript
npx convex dev --once --tail-logs disable
npm run smoke:convex
```

It must only run against a development deployment.
