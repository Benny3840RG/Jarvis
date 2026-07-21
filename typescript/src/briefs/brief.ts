import type { Asset } from "../assets/asset.js";
import { deriveAssetView, type AssetView } from "../assets/assetView.js";
import type { Reminder, Task } from "../persistence/types.js";
import { PROJECT_STATUSES, type Project, type ProjectStatus } from "../projects/project.js";
import { QUOTE_STATUSES, roundMoney, type Quote, type QuoteStatus } from "../quotes/quote.js";

/** Highlight lists are capped so the brief stays a digest, not a data dump. */
export const BRIEF_HIGHLIGHT_LIMIT = 5;

/** Reminders due within this window of "now" count as upcoming. */
export const BRIEF_UPCOMING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Assets whose next service falls within this window of "now" count as due soon. */
export const BRIEF_MAINTENANCE_SOON_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface BriefTasks {
  openCount: number;
  completedCount: number;
  /** Longest-outstanding open tasks first, capped. */
  open: Task[];
}

export interface BriefReminders {
  dueCount: number;
  upcomingCount: number;
  undatedCount: number;
  /** Reminders whose due time has passed, soonest overdue first, capped. */
  due: Reminder[];
  /** Reminders due within the next 24 hours, soonest first, capped. */
  upcoming: Reminder[];
}

export interface BriefProjects {
  activeCount: number;
  countsByStatus: Record<ProjectStatus, number>;
  /** Most recently touched active projects first, capped. */
  active: Project[];
}

export interface BriefQuotes {
  countsByStatus: Record<QuoteStatus, number>;
  /** Total value of quotes that are sent and awaiting a response. */
  pipelineTotal: number;
  /** Total value of accepted quotes. */
  acceptedTotal: number;
  /** Sent quotes awaiting a response, most recently touched first, capped. */
  awaitingResponse: Quote[];
  /** Draft quotes still to be finished and sent, most recently touched first, capped. */
  drafts: Quote[];
}

export interface BriefMaintenance {
  dueCount: number;
  dueSoonCount: number;
  /** Assets whose service is overdue, soonest-due first, capped. */
  due: AssetView[];
  /** Assets not yet due but due within the soon window, soonest-due first, capped. */
  dueSoon: AssetView[];
}

export interface DailyBrief {
  generatedAt: string;
  timezone: string;
  headline: string;
  tasks: BriefTasks;
  reminders: BriefReminders;
  projects: BriefProjects;
  quotes: BriefQuotes;
  maintenance: BriefMaintenance;
}

export interface BriefInputs {
  now: number;
  timezone: string;
  tasks: Task[];
  reminders: Reminder[];
  projects: Project[];
  quotes: Quote[];
  assets: Asset[];
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function cap<T>(items: T[]): T[] {
  return items.slice(0, BRIEF_HIGHLIGHT_LIMIT);
}

function statusCounts<S extends string>(
  statuses: readonly S[],
  items: { status: S }[],
): Record<S, number> {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<S, number>;
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/**
 * Composes the daily brief from the authoritative store contents. Pure and
 * deterministic for a given `now`: every number and highlight is derived from
 * the supplied data, never invented.
 */
export function composeDailyBrief(inputs: BriefInputs): DailyBrief {
  const openTasks = inputs.tasks
    .filter((task) => !task.completed)
    .sort((a, b) => a.createdAt - b.createdAt);
  const completedCount = inputs.tasks.length - openTasks.length;

  const dated = inputs.reminders
    .filter((reminder): reminder is Reminder & { dueAt: number } => reminder.dueAt !== undefined)
    .sort((a, b) => a.dueAt - b.dueAt);
  const due = dated.filter((reminder) => reminder.dueAt <= inputs.now);
  const upcoming = dated.filter(
    (reminder) =>
      reminder.dueAt > inputs.now && reminder.dueAt <= inputs.now + BRIEF_UPCOMING_WINDOW_MS,
  );
  const undatedCount = inputs.reminders.length - dated.length;

  const projectCounts = statusCounts(PROJECT_STATUSES, inputs.projects);
  const activeProjects = inputs.projects
    .filter((project) => project.status === "active")
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const quoteCounts = statusCounts(QUOTE_STATUSES, inputs.quotes);
  const byRecency = (a: Quote, b: Quote) => b.updatedAt - a.updatedAt;
  const awaitingResponse = inputs.quotes.filter((quote) => quote.status === "sent").sort(byRecency);
  const drafts = inputs.quotes.filter((quote) => quote.status === "draft").sort(byRecency);
  const sumTotals = (quotes: Quote[]) =>
    roundMoney(quotes.reduce((sum, quote) => sum + quote.total, 0));

  const assetViews = inputs.assets.map((asset) => deriveAssetView(asset, inputs.now));
  const byNextDue = (a: AssetView, b: AssetView) => (a.nextDueAt ?? 0) - (b.nextDueAt ?? 0);
  const dueAssets = assetViews.filter((asset) => asset.due).sort(byNextDue);
  const dueSoonAssets = assetViews
    .filter(
      (asset) =>
        !asset.due &&
        asset.nextDueAt !== undefined &&
        asset.nextDueAt <= inputs.now + BRIEF_MAINTENANCE_SOON_WINDOW_MS,
    )
    .sort(byNextDue);

  const headline = [
    countLabel(openTasks.length, "open task"),
    countLabel(due.length, "reminder due", "reminders due"),
    countLabel(activeProjects.length, "active project"),
    countLabel(awaitingResponse.length, "quote awaiting response", "quotes awaiting response"),
  ].join(", ");

  return {
    generatedAt: new Date(inputs.now).toISOString(),
    timezone: inputs.timezone,
    headline: `${headline}.`,
    tasks: {
      openCount: openTasks.length,
      completedCount,
      open: cap(openTasks),
    },
    reminders: {
      dueCount: due.length,
      upcomingCount: upcoming.length,
      undatedCount,
      due: cap(due),
      upcoming: cap(upcoming),
    },
    projects: {
      activeCount: activeProjects.length,
      countsByStatus: projectCounts,
      active: cap(activeProjects),
    },
    quotes: {
      countsByStatus: quoteCounts,
      pipelineTotal: sumTotals(awaitingResponse),
      acceptedTotal: sumTotals(inputs.quotes.filter((quote) => quote.status === "accepted")),
      awaitingResponse: cap(awaitingResponse),
      drafts: cap(drafts),
    },
    maintenance: {
      dueCount: dueAssets.length,
      dueSoonCount: dueSoonAssets.length,
      due: cap(dueAssets),
      dueSoon: cap(dueSoonAssets),
    },
  };
}
