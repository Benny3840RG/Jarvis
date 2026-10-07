import type { Asset } from "../assets/asset.js";
import { deriveAssetView, type AssetView } from "../assets/assetView.js";
import { ENQUIRY_URGENCIES, type Enquiry, type EnquiryUrgency } from "../enquiries/enquiry.js";
import type { Errand } from "../errands/errand.js";
import type { Invoice } from "../invoices/invoice.js";
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

export interface BriefEnquiries {
  openCount: number;
  countsByUrgency: Record<EnquiryUrgency, number>;
  /** Open enquiries, most urgent first, then longest waiting, capped. */
  open: Enquiry[];
}

export interface BriefInvoices {
  draftCount: number;
  /** Issued invoices with a balance still due. */
  unpaidCount: number;
  /** Sum of `balanceDue` across unpaid invoices, rounded to cents. */
  unpaidTotal: number;
  /**
   * Unpaid invoices, oldest issue first, capped. No overdue status is derived:
   * `dueDate` is free text, so the brief does not guess at dates.
   */
  unpaid: Invoice[];
}

export interface BriefErrands {
  openCount: number;
  /** Distinct places (location labels) across the open errands. */
  locationCount: number;
  /**
   * Open errands, located ones first grouped by place label, then oldest first,
   * capped. Mirrors the "I'm at the shop, what do I need?" pull: things to grab,
   * ordered so one stop's items sit together.
   */
  open: Errand[];
}

export interface BriefScheduled {
  /** Jobs booked for a past day that are still not done ("booked but not done"). */
  overdueCount: number;
  /** Jobs booked for the operator-local today. */
  todayCount: number;
  /** Jobs booked after today through the end of the current Mon–Sun week. */
  thisWeekCount: number;
  /** Active-status jobs with no booked date. */
  unscheduledCount: number;
  /** Overdue booked jobs, most overdue (earliest booked day) first, capped. */
  overdue: Project[];
  /** Jobs booked for today, soonest-updated first, capped. */
  today: Project[];
  /** Jobs booked later this week, soonest-booked first then most-recently-updated, capped. */
  thisWeek: Project[];
  /** Active jobs with no booked date, most recently touched first, capped. */
  unscheduled: Project[];
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
  enquiries: BriefEnquiries;
  invoices: BriefInvoices;
  errands: BriefErrands;
  scheduled: BriefScheduled;
}

export interface BriefInputs {
  now: number;
  timezone: string;
  tasks: Task[];
  reminders: Reminder[];
  projects: Project[];
  quotes: Quote[];
  assets: Asset[];
  enquiries: Enquiry[];
  invoices: Invoice[];
  errands: Errand[];
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
 * The operator-local calendar date for an instant, as `YYYY-MM-DD`. Intl with
 * the IANA `timezone` returns the wall-clock date, so DST transitions and the
 * zone offset are handled by the platform, not by us. `en-CA` formats as
 * ISO `YYYY-MM-DD`. Requires a valid IANA timezone (the one the brief already
 * carries); an invalid zone throws, the same contract as the rest of the brief.
 */
export function operatorLocalDate(now: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

/**
 * The Monday–Sunday week containing an ISO `YYYY-MM-DD` date, as `{ start, end }`
 * ISO dates. Week arithmetic is done on the calendar date itself (anchored at
 * UTC midnight), so it never depends on any zone or DST: the input already names
 * a calendar day. Lexicographic `YYYY-MM-DD` comparison equals chronological
 * order, so callers can range-compare the returned bounds as plain strings.
 */
export function isoWeekRange(isoDate: string): { start: string; end: string } {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // getUTCDay: 0=Sun..6=Sat. Days back to Monday, and forward to Sunday.
  const daysFromMonday = (date.getUTCDay() + 6) % 7;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - daysFromMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

/**
 * The soonest not-done job booked on or after the operator-local today.
 * Uses the same live-booking predicate as {@link composeDailyBrief}
 * (`status !== "done"` and a `scheduledFor` calendar day). Jobs booked only
 * after this week are included, because "next" is the earliest future booking,
 * not the week digest window.
 */
export function nextBookedJob(
  projects: readonly Project[],
  now: number,
  timezone: string,
): (Project & { scheduledFor: string }) | undefined {
  const localToday = operatorLocalDate(now, timezone);
  const upcoming = projects.filter(
    (project): project is Project & { scheduledFor: string } =>
      project.status !== "done" &&
      typeof project.scheduledFor === "string" &&
      project.scheduledFor >= localToday,
  );
  upcoming.sort((a, b) =>
    a.scheduledFor < b.scheduledFor
      ? -1
      : a.scheduledFor > b.scheduledFor
        ? 1
        : b.updatedAt - a.updatedAt,
  );
  return upcoming[0];
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

  // Scheduled jobs: compare each project's booked calendar day (scheduledFor,
  // a bare YYYY-MM-DD) against the operator-local today and this week. All date
  // comparisons are lexicographic on YYYY-MM-DD, which equals chronological
  // order, so no instant/zone maths is involved beyond deriving "today".
  const localToday = operatorLocalDate(inputs.now, inputs.timezone);
  const weekEnd = isoWeekRange(localToday).end;
  const bookedLiveJobs = inputs.projects.filter(
    (project): project is Project & { scheduledFor: string } =>
      project.status !== "done" && typeof project.scheduledFor === "string",
  );
  const bySchedule = (
    a: Project & { scheduledFor: string },
    b: Project & { scheduledFor: string },
  ) =>
    a.scheduledFor < b.scheduledFor
      ? -1
      : a.scheduledFor > b.scheduledFor
        ? 1
        : b.updatedAt - a.updatedAt;
  const overdueScheduled = bookedLiveJobs
    .filter((project) => project.scheduledFor < localToday)
    .sort(bySchedule);
  const scheduledToday = bookedLiveJobs
    .filter((project) => project.scheduledFor === localToday)
    .sort(bySchedule);
  const scheduledThisWeek = bookedLiveJobs
    .filter((project) => project.scheduledFor > localToday && project.scheduledFor <= weekEnd)
    .sort(bySchedule);
  const unscheduledActive = inputs.projects
    .filter((project) => project.status === "active" && project.scheduledFor === undefined)
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

  // Most urgent first; within one urgency, the enquiry waiting longest first.
  const urgencyRank = (urgency: EnquiryUrgency) =>
    ENQUIRY_URGENCIES.length - 1 - ENQUIRY_URGENCIES.indexOf(urgency);
  const openEnquiries = inputs.enquiries
    .filter((enquiry) => enquiry.status === "open")
    .sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency) || a.createdAt - b.createdAt);
  const enquiryUrgencyCounts = Object.fromEntries(
    ENQUIRY_URGENCIES.map((urgency) => [urgency, 0]),
  ) as Record<EnquiryUrgency, number>;
  for (const enquiry of openEnquiries) enquiryUrgencyCounts[enquiry.urgency] += 1;

  const unpaidInvoices = inputs.invoices
    .filter((invoice) => invoice.status === "issued" && invoice.balanceDue > 0)
    .sort((a, b) => (a.issuedAt ?? a.createdAt) - (b.issuedAt ?? b.createdAt));
  const draftInvoiceCount = inputs.invoices.filter((invoice) => invoice.status === "draft").length;

  // Located errands first, grouped by place label (so one stop's items sit
  // together), then the oldest within each place; unlocated errands trail.
  const openErrands = inputs.errands
    .filter((errand) => errand.status === "open")
    .sort((a, b) => {
      const labelA = a.location?.label ?? "";
      const labelB = b.location?.label ?? "";
      if ((labelA === "") !== (labelB === "")) return labelA === "" ? 1 : -1;
      if (labelA !== labelB) return labelA < labelB ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
  const errandLocationCount = new Set(
    openErrands
      .map((errand) => errand.location?.label)
      .filter((label): label is string => label !== undefined),
  ).size;

  const headline = [
    countLabel(openTasks.length, "open task"),
    countLabel(due.length, "reminder due", "reminders due"),
    countLabel(activeProjects.length, "active project"),
    countLabel(awaitingResponse.length, "quote awaiting response", "quotes awaiting response"),
    countLabel(openEnquiries.length, "open enquiry", "open enquiries"),
    countLabel(unpaidInvoices.length, "invoice unpaid", "invoices unpaid"),
    countLabel(openErrands.length, "errand to run", "errands to run"),
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
    enquiries: {
      openCount: openEnquiries.length,
      countsByUrgency: enquiryUrgencyCounts,
      open: cap(openEnquiries),
    },
    invoices: {
      draftCount: draftInvoiceCount,
      unpaidCount: unpaidInvoices.length,
      unpaidTotal: roundMoney(unpaidInvoices.reduce((sum, invoice) => sum + invoice.balanceDue, 0)),
      unpaid: cap(unpaidInvoices),
    },
    errands: {
      openCount: openErrands.length,
      locationCount: errandLocationCount,
      open: cap(openErrands),
    },
    scheduled: {
      overdueCount: overdueScheduled.length,
      todayCount: scheduledToday.length,
      thisWeekCount: scheduledThisWeek.length,
      unscheduledCount: unscheduledActive.length,
      overdue: cap(overdueScheduled),
      today: cap(scheduledToday),
      thisWeek: cap(scheduledThisWeek),
      unscheduled: cap(unscheduledActive),
    },
  };
}
