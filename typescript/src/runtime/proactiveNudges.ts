import type { Reminder, Task } from "../persistence/types.js";

/**
 * Proactive nudges: read-only suggestions about tasks and reminders that need
 * the owner's attention. They never change state; the owner decides what to do.
 */

/** Two upcoming reminders closer together than this are reported as a clash. */
export const CLASH_WINDOW_MS = 15 * 60 * 1000;

/** A pending task not created or edited for this long is reported as stale. */
export const STALE_TASK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type NudgeKind = "overdue-reminder" | "reminder-clash" | "untimed-reminder" | "stale-task";

export interface Nudge {
  kind: NudgeKind;
  /** Ids of the tasks or reminders this nudge is about. */
  refs: string[];
  message: string;
}

export interface NudgeInputs {
  tasks: readonly Task[];
  reminders: readonly Reminder[];
  now: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function describeAgo(ms: number): string {
  if (ms >= DAY_MS) return plural(Math.floor(ms / DAY_MS), "day");
  if (ms >= HOUR_MS) return plural(Math.floor(ms / HOUR_MS), "hour");
  return plural(Math.max(1, Math.floor(ms / 60000)), "minute");
}

function overdueReminders(reminders: readonly Reminder[], now: number): Nudge[] {
  return reminders
    .filter((r): r is Reminder & { dueAt: number } => r.dueAt !== undefined && r.dueAt < now)
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((r) => ({
      kind: "overdue-reminder" as const,
      refs: [r.id],
      message: `"${r.title}" was due ${describeAgo(now - r.dueAt)} ago. Reschedule it or remove it?`,
    }));
}

function reminderClashes(reminders: readonly Reminder[], now: number): Nudge[] {
  const upcoming = reminders
    .filter((r): r is Reminder & { dueAt: number } => r.dueAt !== undefined && r.dueAt >= now)
    .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
  const nudges: Nudge[] = [];
  for (let i = 0; i + 1 < upcoming.length; i += 1) {
    const first = upcoming[i]!;
    const second = upcoming[i + 1]!;
    if (second.dueAt - first.dueAt < CLASH_WINDOW_MS) {
      nudges.push({
        kind: "reminder-clash",
        refs: [first.id, second.id],
        message: `"${first.title}" and "${second.title}" are due within 15 minutes of each other. Move one?`,
      });
    }
  }
  return nudges;
}

function untimedReminders(reminders: readonly Reminder[]): Nudge[] {
  return reminders
    .filter((r) => r.dueAt === undefined && (r.dueRaw ?? "").trim() !== "")
    .map((r) => ({
      kind: "untimed-reminder" as const,
      refs: [r.id],
      message: `"${r.title}" has no exact time, so it will not go off. Give it a time?`,
    }));
}

function staleTasks(tasks: readonly Task[], now: number): Nudge[] {
  return tasks
    .map((t) => ({ task: t, touched: t.updatedAt ?? t.createdAt }))
    .filter(({ task, touched }) => !task.completed && now - touched >= STALE_TASK_AGE_MS)
    .sort((a, b) => a.touched - b.touched)
    .map(({ task, touched }) => ({
      kind: "stale-task" as const,
      refs: [task.id],
      message: `"${task.title}" has not moved in ${describeAgo(now - touched)}. Still needed?`,
    }));
}

/** Ordered by urgency: overdue, clash, untimed, stale. Inputs are not mutated. */
export function computeNudges(inputs: NudgeInputs): Nudge[] {
  const { tasks, reminders, now } = inputs;
  return [
    ...overdueReminders(reminders, now),
    ...reminderClashes(reminders, now),
    ...untimedReminders(reminders),
    ...staleTasks(tasks, now),
  ];
}

export function formatNudges(nudges: readonly Nudge[]): string {
  if (nudges.length === 0) return "All clear. Nothing needs your attention.";
  const heading =
    nudges.length === 1
      ? "1 thing needs your attention:"
      : `${nudges.length} things need your attention:`;
  return [heading, ...nudges.map((n, i) => `${i + 1}. ${n.message}`)].join("\n");
}
