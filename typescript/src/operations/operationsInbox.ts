import type { Asset } from "../assets/asset.js";
import { deriveAssetView } from "../assets/assetView.js";
import type { Reminder } from "../persistence/types.js";
import { compareInboxItems, type InboxSeverity } from "./inboxSeverity.js";

/** Reminders due in the next 24 hours also appear in the inbox — matches BRIEF_UPCOMING_WINDOW_MS in briefs/brief.ts. */
export const REMINDER_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Assets due within this window of "now" (but not yet overdue) count as due soon — matches BRIEF_MAINTENANCE_SOON_WINDOW_MS in briefs/brief.ts. */
export const MAINTENANCE_SOON_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const INBOX_SOURCES = [
  "reminders",
  "maintenance",
  "toolActions",
  "reconciliation",
  "quoteDelivery",
] as const;
export type InboxSourceName = (typeof INBOX_SOURCES)[number];

export type InboxSourceStatus = "available" | "unavailable" | "degraded" | "unsupported";

export interface InboxSourceReport {
  source: InboxSourceName;
  status: InboxSourceStatus;
  reason?: string;
  checkedAt: string;
}

export type InboxItemKind =
  "reminder-overdue" | "reminder-due-soon" | "maintenance-overdue" | "maintenance-due-soon";

export interface InboxItem {
  itemId: string;
  kind: InboxItemKind;
  severity: InboxSeverity;
  title: string;
  explanation: string;
  sourceSubsystem: InboxSourceName;
  sourceRecordId: string;
  createdAt: string;
  dueAt?: string;
  updatedAt: string;
  status: string;
  actionRequired: boolean;
}

export interface OperationsInbox {
  generatedAt: string;
  items: InboxItem[];
  sources: InboxSourceReport[];
}

export interface OperationsInboxInputs {
  now: number;
  listReminders(): Promise<Reminder[]>;
  listAssets(): Promise<Asset[]>;
}

const UNSUPPORTED_REASONS: Record<"toolActions" | "reconciliation" | "quoteDelivery", string> = {
  toolActions:
    "Governed ToolAction consent-lifecycle read (awaiting approval, nearing expiry, expired, revoked) is not yet wired into the inbox.",
  reconciliation:
    "Reconciliation escalation read is not yet wired into the inbox — pending the operator read-model landing on main.",
  quoteDelivery:
    "No bounded, owner-wide read exists yet for quote-delivery attempts across all quotes; only a per-quote read is currently available.",
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function reportSource<T, TSource extends "reminders" | "maintenance">(
  source: TSource,
  now: number,
  read: () => Promise<T>,
): Promise<{ report: InboxSourceReport; value: T | null }> {
  try {
    const value = await read();
    return { report: { source, status: "available", checkedAt: iso(now) }, value };
  } catch (error: unknown) {
    void error;
    const reasonBySource: Record<"reminders" | "maintenance", string> = {
      reminders: "Reminders source is temporarily unavailable.",
      maintenance: "Maintenance source is temporarily unavailable.",
    };
    return {
      report: {
        source,
        status: "unavailable",
        reason: reasonBySource[source],
        checkedAt: iso(now),
      },
      value: null,
    };
  }
}

function reminderItems(reminders: Reminder[], now: number): InboxItem[] {
  const items: InboxItem[] = [];
  for (const reminder of reminders) {
    const dueAt = reminder.dueAt;
    if (dueAt === undefined || dueAt > now + REMINDER_SOON_WINDOW_MS) continue;
    const overdue = dueAt <= now;
    items.push({
      itemId: `reminder-${overdue ? "overdue" : "due-soon"}:${reminder.id}`,
      kind: overdue ? "reminder-overdue" : "reminder-due-soon",
      severity: "normal",
      title: reminder.title,
      explanation: overdue
        ? `Reminder due ${iso(dueAt)} has passed.`
        : `Reminder falls due ${iso(dueAt)}.`,
      sourceSubsystem: "reminders",
      sourceRecordId: reminder.id,
      createdAt: iso(reminder.createdAt),
      dueAt: iso(dueAt),
      updatedAt: iso(dueAt),
      status: overdue ? "overdue" : "due-soon",
      actionRequired: overdue,
    });
  }
  return items;
}

function maintenanceItems(assets: Asset[], now: number): InboxItem[] {
  const items: InboxItem[] = [];
  for (const asset of assets) {
    const view = deriveAssetView(asset, now);
    if (view.nextDueAt === undefined) continue;
    if (view.due) {
      items.push({
        itemId: `maintenance-overdue:${asset.id}`,
        kind: "maintenance-overdue",
        severity: "elevated",
        title: asset.name,
        explanation: `Service was due ${iso(view.nextDueAt)} and has not been recorded since.`,
        sourceSubsystem: "maintenance",
        sourceRecordId: asset.id,
        createdAt: iso(asset.createdAt),
        dueAt: iso(view.nextDueAt),
        updatedAt: iso(asset.updatedAt),
        status: "overdue",
        actionRequired: true,
      });
    } else if (view.nextDueAt <= now + MAINTENANCE_SOON_WINDOW_MS) {
      items.push({
        itemId: `maintenance-due-soon:${asset.id}`,
        kind: "maintenance-due-soon",
        severity: "normal",
        title: asset.name,
        explanation: `Service falls due ${iso(view.nextDueAt)}.`,
        sourceSubsystem: "maintenance",
        sourceRecordId: asset.id,
        createdAt: iso(asset.createdAt),
        dueAt: iso(view.nextDueAt),
        updatedAt: iso(asset.updatedAt),
        status: "due-soon",
        actionRequired: false,
      });
    }
  }
  return items;
}

/**
 * Composes the read-only Operations Inbox from existing authoritative
 * sources. Each source is read independently — one source's failure is
 * reported on its own `InboxSourceReport` and never suppresses another
 * source's items or fails the whole response. Sources with no wired read
 * yet (governed ToolActions, reconciliation, quote delivery) are reported
 * `"unsupported"` with a concrete reason rather than silently omitted.
 */
export async function buildOperationsInbox(
  inputs: OperationsInboxInputs,
): Promise<OperationsInbox> {
  const [reminders, assets] = await Promise.all([
    reportSource("reminders", inputs.now, inputs.listReminders),
    reportSource("maintenance", inputs.now, inputs.listAssets),
  ]);

  const items = [
    ...(reminders.value ? reminderItems(reminders.value, inputs.now) : []),
    ...(assets.value ? maintenanceItems(assets.value, inputs.now) : []),
  ].sort(compareInboxItems);

  const unsupported: InboxSourceReport[] = (
    ["toolActions", "reconciliation", "quoteDelivery"] as const
  ).map((source) => ({
    source,
    status: "unsupported",
    reason: UNSUPPORTED_REASONS[source],
    checkedAt: iso(inputs.now),
  }));

  return {
    generatedAt: iso(inputs.now),
    items,
    sources: [reminders.report, assets.report, ...unsupported],
  };
}
