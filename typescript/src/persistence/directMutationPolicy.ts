/**
 * Direct-mutation policy shared by every persistence provider.
 *
 * Project-scoped tasks and reminders (records carrying a `projectId`) are owned
 * by controlled action execution, which records revisions and receipts. The
 * plain update/complete/remove operations must refuse them so that the rule
 * does not depend on which backend is active.
 *
 * The error messages are part of the contract: the HTTP controllers map
 * "controlled task execution" / "controlled reminder execution" to a 409
 * `controlled-*-boundary` problem.
 */

export const CONTROLLED_TASK_MUTATION_ERROR =
  "Project-scoped tasks must be changed through controlled task execution.";

export const CONTROLLED_REMINDER_MUTATION_ERROR =
  "Project-scoped reminders must be changed through controlled reminder execution.";

export function requireDirectlyMutableTask(task: { projectId?: string }): void {
  if (task.projectId !== undefined) throw new Error(CONTROLLED_TASK_MUTATION_ERROR);
}

export function requireDirectlyMutableReminder(reminder: { projectId?: string }): void {
  if (reminder.projectId !== undefined) throw new Error(CONTROLLED_REMINDER_MUTATION_ERROR);
}
