# Task and Reminder Actions — Development Commissioning Evidence

## Disposition

`AM-004 Create task`, `AM-005 Complete task`, `AM-006 Create reminder`, and `AM-007 Cancel reminder` are commissioned as active action families on the authorised Convex development deployment.

This record does not authorise or record a Convex or Manufact production deployment.

## Verified revisions

- Runtime implementation merge: `48a7b69390eef65d010581d4b2ebe1c382ed50b7` (PR #161)
- Commissioning harness merge: `5fc8c3f477bfa9ce121b56575b0336105c37de8f` (PR #162)
- Commissioning workflow source: `77ba3197d6525fec1b172ac47b852a698977b695`
- GitHub Actions workflow run: `30065629012`
- Commissioning job: `89395897530`
- Evidence artifact: `8586149430`
- Artifact name: `task-reminder-development-commissioning-30065629012`
- Artifact digest: `sha256:f061c997413034144bfe82bfb50c49bec579019168f1ac0076c384b19fa7883a`
- Evidence issue comment: https://github.com/Benny3840/Jarvis/issues/155#issuecomment-5066008811

## Authorised target

- Deployment: `dev:outgoing-ram-798`
- URL: `https://outgoing-ram-798.convex.cloud`
- Production deployment: **not authorised and not performed**

## Passed gates

- Locked dependency installation and complete `npm run check`
- Convex function sync using `npx convex dev --once`
- Task create and mutation-level idempotent replay
- Fresh-client task persistence visibility
- Task completion, revision advancement, and exact replay
- Reminder create and mutation-level idempotent replay
- Fresh-client reminder persistence visibility
- Cancellation tombstone retained before live-record deletion
- Cancellation replay after live-record deletion
- Authenticated cleanup and post-cleanup absence
- Development-only target guard

## Bound implementation

- `AM-004` → `TOOL-TASKS-CREATE` → `tasks:create` → `STORE-TASKS`
- `AM-005` → `TOOL-TASKS-COMPLETE` → `tasks:complete` → `STORE-TASKS`
- `AM-006` → `TOOL-REMINDERS-CREATE` → `reminders:create` → `STORE-REMINDERS`
- `AM-007` → `TOOL-REMINDERS-CANCEL` → `reminders:cancel` → `STORE-REMINDERS`

## Preserved boundaries

- `AM-012 Finalize quote` remains planned.
- `AM-013 Send quote` remains planned.
- External reconciliation remains required before any sending capability is activated.
- Manufact core production remains locked to inactive deployment branches.
