# Proactive nudges

`src/runtime/proactiveNudges.ts` points out tasks and reminders that need the
owner's attention. It is read-only. It suggests; it never changes, removes or
reschedules anything.

`computeNudges({ tasks, reminders, now })` returns nudges in this order:

| Kind               | Rule                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `overdue-reminder` | `dueAt` is before `now`. Oldest first.                                     |
| `reminder-clash`   | Two upcoming reminders are less than 15 minutes apart (`CLASH_WINDOW_MS`). |
| `untimed-reminder` | Has due text (`dueRaw`) but no `dueAt`, so it will never go off.           |
| `stale-task`       | Pending and not created or edited for 7 days (`STALE_TASK_AGE_MS`).        |

`formatNudges` turns them into a numbered list, or "All clear. Nothing needs
your attention."

The CLI `summary` command prints the nudges after the pending-task line and
adds them to its JSON output as `nudges`.

```ts
const nudges = computeNudges({ tasks, reminders, now: Date.now() });
console.log(formatNudges(nudges));
```

Not done yet: nudges in the HUD, voice or HTTP API. Those change operator-visible
behaviour and need the OpenAPI contract updated first, and Benny's spoken check
for HUD/voice.
