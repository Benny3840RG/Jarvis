export type InboxSeverity = "critical" | "high" | "elevated" | "normal" | "informational";

/**
 * Fixed severity order per the Operations Inbox design: confirmed
 * safety/external-effect uncertainty and failed consequential actions rank
 * above overdue commitments, which rank above routine due-soon items. This
 * is the only place severity rank is defined — nothing else in the inbox
 * pipeline invents an ordering.
 */
export const SEVERITY_RANK: Record<InboxSeverity, number> = {
  critical: 0,
  high: 1,
  elevated: 2,
  normal: 3,
  informational: 4,
};

export interface InboxOrderable {
  itemId: string;
  severity: InboxSeverity;
  sourceSubsystem: string;
  /** ISO timestamp. Absent due dates sort after any dated item at the same severity. */
  dueAt?: string;
}

/**
 * Deterministic total order for inbox items: severity rank, then earliest
 * due date first (undated last), then sourceSubsystem, then itemId. The
 * final two keys exist purely to break exact ties (equal severity and equal
 * or absent due date) so the same input always produces the same output
 * order regardless of array insertion order.
 */
export function compareInboxItems(a: InboxOrderable, b: InboxOrderable): number {
  const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (severityDelta !== 0) return severityDelta;

  if (a.dueAt !== b.dueAt) {
    if (a.dueAt === undefined) return 1;
    if (b.dueAt === undefined) return -1;
    const dueDelta = Date.parse(a.dueAt) - Date.parse(b.dueAt);
    if (dueDelta !== 0) return dueDelta;
  }

  const subsystemDelta = a.sourceSubsystem.localeCompare(b.sourceSubsystem);
  if (subsystemDelta !== 0) return subsystemDelta;

  return a.itemId.localeCompare(b.itemId);
}
