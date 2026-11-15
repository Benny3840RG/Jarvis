# AM-017 Reschedule reminder — Implementation Evidence (planning only)

## Disposition

`AM-017 Reschedule reminder` is **lifecycle_status planned**. This record covers the implementation and local verification only. It does **not** record a Convex deployment, a commissioning run, or an activation decision.

- Convex deployment of `reminders:rescheduleControlled`: **not performed**
- Commissioning smoke against an authorised development deployment: **not performed**
- Production deployment: **not authorised and not performed**

## What exists

- `typescript/convex/reminders.ts` — `rescheduleControlled`. It is owner- and project-scoped and replaces the reminder's due value as a whole:
  - the raw text is always kept, and a normalized `dueAt` is stored only with its `dueTimezone`
  - it bumps `revision` and `updatedAt`
  - it retains the result in `internalActionResults` under `actionFamilyId: "AM-017"` and the execution idempotency key
  - a replay returns the original result
  - a different fingerprint on the same key is rejected
  - a reminder in another project, or a missing reminder, returns `null`
- `typescript/convex/internalActionValidators.ts` — `AM-017` is added to the internal action family validator.
- `typescript/src/persistence/convexControlledReminders.ts` — the `reschedule` adapter.
- `typescript/src/actions/taskReminderTools.ts`:
  - `reminders:reschedule` (`TOOL-REMINDERS-RESCHEDULE`) with strict arguments `{ reminderId, dueRaw, dueAt?, dueTimezone? }`, where `dueAt` and `dueTimezone` must be supplied together
  - it is registered **only** when `JARVIS_REMINDER_RESCHEDULE_ENABLED` is exactly `"true"` and the reminder store supports rescheduling
- NOLAN voice (`typescript/src/voice/*`):
  - Phrasings such as "Nolan, move the bar oil reminder to Friday at 9 am" resolve to one reminder in the voice project, are read back with the new time, and on confirm stage `reminders:reschedule` for owner approval.
  - Voice never approves or executes.
  - While the flag is unset, a spoken reschedule is refused before any records are read.

## Local verification

- `TEST-AM-017-DOMAIN-001`: `typescript/convex/reminderReschedule.test.ts` (convex-test, the real mutation)
- `TEST-AM-017-TOOL-001`: `typescript/tests/taskReminderAllowlist.test.ts`
- `TEST-AM-017-PERSIST-001`: `typescript/tests/convexControlledReminders.test.ts`
- `TEST-AM-017-VOICE-001`: `typescript/tests/voiceSafeWrite.test.ts`

## Activation path (owner decision, not performed here)

1. Deploy the Convex functions to the authorised development deployment.
2. Set `JARVIS_REMINDER_RESCHEDULE_ENABLED=true` for the server.
3. Run a commissioning smoke:
   - reschedule a voice-project reminder, replay the same execution, confirm a single revision bump, and clean up
4. Record the run here.
5. Only then change AM-017 and `TOOL-REMINDERS-RESCHEDULE` to `active` in a separate governance change.
