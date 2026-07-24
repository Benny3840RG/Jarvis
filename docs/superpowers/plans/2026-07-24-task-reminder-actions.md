# Task and Reminder Action Families Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commission create/complete task and create/cancel reminder as safe internal action families after AM-003.

**Architecture:** Preserve legacy CRUD while adding controlled owner/project-scoped mutations. Each controlled mutation atomically writes a typed `internalActionResults` record with the entity change, closing the crash window between domain mutation and execution receipt persistence. Tool definitions receive immutable execution context and only four reviewed operations are appended to the existing allowlist.

**Tech Stack:** TypeScript, Zod, Convex, Node test runner, GitHub Actions, YAML action-family governance.

## Global Constraints

- Development only; no Convex production deployment.
- Preserve existing CLI task/reminder behavior and snapshot compatibility.
- Controlled actions may operate only on owner/project-scoped controlled records.
- Every mutation-level replay must bind to the exact canonical action fingerprint.
- Reminder cancellation must retain an atomic result tombstone before deleting the live reminder.
- Keep quote actions planned.

---

### Task 1: Atomic internal-action results

**Files:**
- Create: `typescript/convex/internalActionValidators.ts`
- Modify: `typescript/convex/schema.ts`

- [ ] Define typed task and reminder result snapshots.
- [ ] Add owner/project/family/idempotency and entity indexes.
- [ ] Reject fingerprint reuse across different payloads.

### Task 2: Controlled task mutations

**Files:**
- Modify: `typescript/convex/tasks.ts`
- Create: `typescript/src/tasks/controlledTask.ts`
- Create: `typescript/src/persistence/convexControlledTasks.ts`
- Test: `typescript/tests/controlledTaskActions.test.ts`
- Test: `typescript/tests/convexControlledTasks.test.ts`

- [ ] Add fingerprint-bound controlled create.
- [ ] Add atomic controlled completion and exact result replay.
- [ ] Keep legacy create/complete/update/remove compatible.
- [ ] Add authenticated cleanup for commissioning only.

### Task 3: Controlled reminder mutations

**Files:**
- Modify: `typescript/convex/reminders.ts`
- Create: `typescript/src/reminders/controlledReminder.ts`
- Create: `typescript/src/persistence/convexControlledReminders.ts`
- Test: `typescript/tests/controlledReminderActions.test.ts`
- Test: `typescript/tests/convexControlledReminders.test.ts`

- [ ] Add fingerprint-bound controlled create.
- [ ] Add atomic cancellation receipt plus live-record deletion.
- [ ] Replay cancellation from the retained result.
- [ ] Keep legacy update/remove and snapshots compatible.
- [ ] Add authenticated cleanup for commissioning only.

### Task 4: Tool contracts and allowlist

**Files:**
- Create: `typescript/src/actions/taskReminderTools.ts`
- Modify: `typescript/src/actions/toolExecutionFactory.ts`
- Test: `typescript/tests/taskReminderAllowlist.test.ts`

- [ ] Register `tasks:create`, `tasks:complete`, `reminders:create`, and `reminders:cancel`.
- [ ] Prove every other operation remains blocked.
- [ ] Validate due-field combinations and authority.

### Task 5: Self-cleaning development smoke

**Files:**
- Create: `typescript/src/tools/taskReminderActionsSmoke.ts`
- Modify: `typescript/src/tools/runConvexSmoke.ts`
- Test: `typescript/tests/taskReminderActionsSmoke.test.ts`

- [ ] Prove create/replay/fresh-client visibility/complete/cancel.
- [ ] Prove cleanup and absence.
- [ ] Refuse non-development targets before touching stores.

### Task 6: Two-stage governance activation

- [ ] Merge runtime with action families still absent/planned.
- [ ] Sync only `dev:outgoing-ram-798` and run the live self-cleaning smoke.
- [ ] Add AM-004 through AM-007, tool/store catalogs, TEST/EVD IDs and evidence.
- [ ] Regenerate the action map and pass final governance validation.
