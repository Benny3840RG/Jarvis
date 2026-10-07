/**
 * Voice query adapter over the read models the HTTP brief and domain stores
 * already expose. List methods only. No writes, no raw storage, no second
 * business definition of unpaid, open, due, or scheduled.
 */

import type { Asset, AssetStore } from "../assets/asset.js";
import {
  composeDailyBrief,
  nextBookedJob,
  type BriefErrands,
  type BriefEnquiries,
  type BriefInvoices,
  type BriefMaintenance,
  type BriefReminders,
  type BriefScheduled,
  type BriefTasks,
  type DailyBrief,
} from "../briefs/brief.js";
import type { Build, BuildStore } from "../builds/build.js";
import type { Enquiry, EnquiryStore } from "../enquiries/enquiry.js";
import type { Errand, ErrandStore } from "../errands/errand.js";
import type { Invoice, InvoiceStore } from "../invoices/invoice.js";
import type { PersistenceProvider, Reminder, Task } from "../persistence/persistence.js";
import type { Project, ProjectStore } from "../projects/project.js";
import type { Quote, QuoteStore } from "../quotes/quote.js";
import { resolveReminderTimezone } from "../reminders/due.js";
import type { VoiceQueryAnswer, VoiceQueryProvider, VoiceQueryRequest } from "./voiceQuery.js";

export type AuthoritativeVoiceQuerySources = {
  /** Same optional IANA zone the daily brief resolves. Invalid values fail closed. */
  timezone: string | undefined;
  tasks: Pick<PersistenceProvider, "listTasks">;
  reminders: Pick<PersistenceProvider, "listReminders">;
  projects: Pick<ProjectStore, "list">;
  quotes: Pick<QuoteStore, "list">;
  assets: Pick<AssetStore, "list">;
  enquiries: Pick<EnquiryStore, "list">;
  invoices: Pick<InvoiceStore, "list">;
  errands: Pick<ErrandStore, "list">;
  builds: Pick<BuildStore, "list">;
};

const HIGHLIGHT_LIMIT = 5;

const EQUIPMENT_STATUS_UNAVAILABLE =
  "Workshop equipment status is unavailable: no commissioned equipment-status source is connected.";

const TIMEZONE_UNAVAILABLE = "Jarvis timezone configuration is unavailable.";

const QUOTE_FOLLOW_UP_UNAVAILABLE =
  "Quote follow-up is unavailable: no owner-wide governed sent-quote read (lifecycle delivery ledger) is connected. The daily-brief quote file is not that register.";

function unavailable(reason: string): VoiceQueryAnswer {
  return { status: "unavailable", reason };
}

function answered(answer: string): VoiceQueryAnswer {
  return { status: "answered", answer };
}

function hardwareUnavailable(kind: "crawler" | "trailer"): string {
  return `Live ${kind} hardware status is unavailable: no commissioned hardware-status source is connected.`;
}

async function readList<T>(
  sourceName: string,
  load: () => Promise<T>,
): Promise<T | VoiceQueryAnswer> {
  try {
    return await load();
  } catch {
    return unavailable(`${sourceName} are unavailable.`);
  }
}

function isUnavailable(value: unknown): value is VoiceQueryAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value as { status?: unknown }).status === "unavailable"
  );
}

function nameList(count: number, names: readonly string[]): string {
  if (names.length === 0) return "";
  const extra = count - names.length;
  const shown = extra > 0 ? `${names.join("; ")}; and ${extra} more` : names.join("; ");
  return ` ${shown}.`;
}

function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

type BriefParts = {
  tasks?: Task[];
  reminders?: Reminder[];
  projects?: Project[];
  quotes?: Quote[];
  assets?: Asset[];
  enquiries?: Enquiry[];
  invoices?: Invoice[];
  errands?: Errand[];
};

function composeSlice(now: number, timezone: string, partial: BriefParts): DailyBrief {
  return composeDailyBrief({
    now,
    timezone,
    tasks: partial.tasks ?? [],
    reminders: partial.reminders ?? [],
    projects: partial.projects ?? [],
    quotes: partial.quotes ?? [],
    assets: partial.assets ?? [],
    enquiries: partial.enquiries ?? [],
    invoices: partial.invoices ?? [],
    errands: partial.errands ?? [],
  });
}

function resolveZone(sources: AuthoritativeVoiceQuerySources): string | VoiceQueryAnswer {
  try {
    return resolveReminderTimezone(sources.timezone);
  } catch {
    return unavailable(TIMEZONE_UNAVAILABLE);
  }
}

function invoicesAnswer(invoices: BriefInvoices): string {
  if (invoices.unpaidCount === 0) return "No unpaid invoices.";
  return `${countNoun(invoices.unpaidCount, "unpaid invoice")}, balance due ${invoices.unpaidTotal.toFixed(2)}.${nameList(
    invoices.unpaidCount,
    invoices.unpaid.map((invoice) => invoice.number),
  )}`;
}

function enquiriesAnswer(enquiries: BriefEnquiries): string {
  if (enquiries.openCount === 0) return "No open enquiries.";
  return `${countNoun(enquiries.openCount, "open enquiry", "open enquiries")}.${nameList(
    enquiries.openCount,
    enquiries.open.map((enquiry) => enquiry.requestedWork),
  )}`;
}

function tasksAnswer(tasks: BriefTasks): string {
  if (tasks.openCount === 0) return "No open tasks.";
  return `${countNoun(tasks.openCount, "open task")}.${nameList(
    tasks.openCount,
    tasks.open.map((task) => task.title),
  )}`;
}

function remindersAnswer(reminders: BriefReminders, registerCount: number): string {
  if (registerCount === 0) return "No reminders.";
  const coveredCount = reminders.dueCount + reminders.upcomingCount + reminders.undatedCount;
  const laterCount = Math.max(0, registerCount - coveredCount);
  let text = `${countNoun(reminders.dueCount, "reminder")} due, ${reminders.upcomingCount} upcoming, ${reminders.undatedCount} undated.`;
  if (laterCount > 0) {
    text += ` ${countNoun(laterCount, "reminder")} scheduled later.`;
  }
  if (reminders.due.length > 0) {
    text += ` Due:${nameList(
      reminders.dueCount,
      reminders.due.map((reminder) => reminder.title),
    )}`;
  }
  if (reminders.upcoming.length > 0) {
    text += ` Upcoming:${nameList(
      reminders.upcomingCount,
      reminders.upcoming.map((reminder) => reminder.title),
    )}`;
  }
  return text;
}

function errandsAnswer(errands: BriefErrands): string {
  if (errands.openCount === 0) return "No open errands.";
  return `${countNoun(errands.openCount, "open errand")}.${nameList(
    errands.openCount,
    errands.open.map((errand) =>
      errand.location?.label ? `${errand.title} at ${errand.location.label}` : errand.title,
    ),
  )}`;
}

function todayAnswer(scheduled: BriefScheduled): string {
  if (scheduled.todayCount === 0) return "No jobs booked for today.";
  return `${countNoun(scheduled.todayCount, "job")} booked for today.${nameList(
    scheduled.todayCount,
    scheduled.today.map((project) => project.title),
  )}`;
}

function thisWeekAnswer(scheduled: BriefScheduled): string {
  if (scheduled.todayCount === 0 && scheduled.thisWeekCount === 0) {
    return "No jobs booked today or later this week.";
  }
  let text = `${countNoun(scheduled.todayCount, "job")} booked for today. ${countNoun(scheduled.thisWeekCount, "job")} booked later this week.`;
  if (scheduled.today.length > 0) {
    text += ` Today:${nameList(
      scheduled.todayCount,
      scheduled.today.map((project) => project.title),
    )}`;
  }
  if (scheduled.thisWeek.length > 0) {
    text += ` Later this week:${nameList(
      scheduled.thisWeekCount,
      scheduled.thisWeek.map((project) => project.title),
    )}`;
  }
  return text;
}

function nextAnswer(
  job: (Project & { scheduledFor: string }) | undefined,
  kind: "job" | "appointment",
): string {
  if (!job) {
    return kind === "job" ? "No upcoming job is booked." : "No upcoming appointment is booked.";
  }
  const lead = kind === "job" ? "Next job" : "Next appointment";
  const time = kind === "appointment" ? " No appointment time is recorded." : "";
  return `${lead} is ${job.title}, booked for ${job.scheduledFor}.${time}`;
}

function maintenanceAnswer(maintenance: BriefMaintenance): string {
  if (maintenance.dueCount === 0 && maintenance.dueSoonCount === 0) {
    return "No maintenance is due or due soon.";
  }
  let text = `${countNoun(maintenance.dueCount, "asset")} overdue for service, ${maintenance.dueSoonCount} due soon.`;
  if (maintenance.due.length > 0) {
    text += ` Overdue:${nameList(
      maintenance.dueCount,
      maintenance.due.map((asset) => asset.name),
    )}`;
  }
  if (maintenance.dueSoon.length > 0) {
    text += ` Due soon:${nameList(
      maintenance.dueSoonCount,
      maintenance.dueSoon.map((asset) => asset.name),
    )}`;
  }
  return text;
}

function listed(count: number, names: readonly string[], empty: string, intro: string): string {
  if (count === 0) return empty;
  return `${intro}.${nameList(count, names)}`;
}

function kindTokens(kind: string): string[] {
  return kind
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function recordedStatus(builds: readonly Build[], kind: "crawler" | "trailer"): string {
  const matched = builds.filter((build) => kindTokens(build.kind).includes(kind));
  const hardware = hardwareUnavailable(kind);
  if (matched.length === 0) return `No recorded ${kind} status. ${hardware}`;
  const names = matched
    .slice(0, HIGHLIGHT_LIMIT)
    .map((build) => `${build.name} is ${build.status}`);
  return `Recorded ${kind} status:${nameList(matched.length, names)} ${hardware}`;
}

function buildsAnswer(builds: readonly Build[]): string {
  return listed(
    builds.length,
    builds.slice(0, HIGHLIGHT_LIMIT).map((build) => `${build.name} is ${build.status}`),
    "No workshop builds are recorded.",
    countNoun(builds.length, "workshop build"),
  );
}

function assetsAnswer(assets: readonly Asset[]): string {
  return listed(
    assets.length,
    assets.slice(0, HIGHLIGHT_LIMIT).map((asset) => asset.name),
    "No workshop assets are recorded.",
    countNoun(assets.length, "workshop asset"),
  );
}

export function createAuthoritativeVoiceQueries(
  sources: AuthoritativeVoiceQuerySources,
): VoiceQueryProvider {
  return {
    async answer(input: VoiceQueryRequest): Promise<VoiceQueryAnswer> {
      try {
        return await dispatchQuery(sources, input);
      } catch {
        return unavailable(
          `The authoritative read for ${input.commandId} failed before an answer could be returned.`,
        );
      }
    },
  };
}

async function dispatchQuery(
  sources: AuthoritativeVoiceQuerySources,
  input: VoiceQueryRequest,
): Promise<VoiceQueryAnswer> {
  switch (input.commandId) {
    case "workshop.status":
      return unavailable(EQUIPMENT_STATUS_UNAVAILABLE);
    case "client.unpaid-invoices":
      return fromInvoices(sources, input.now);
    case "client.open-enquiries":
      return fromEnquiries(sources, input.now);
    case "client.quote-follow-up":
      return unavailable(QUOTE_FOLLOW_UP_UNAVAILABLE);
    case "client.open-tasks":
      return fromTasks(sources, input.now);
    case "client.reminders":
      return fromReminders(sources, input.now);
    case "client.open-errands":
      return fromErrands(sources, input.now);
    case "client.todays-schedule":
      return fromSchedule(sources, input.now, "today");
    case "client.jobs-this-week":
      return fromSchedule(sources, input.now, "week");
    case "workshop.next-job":
      return fromSchedule(sources, input.now, "next-job");
    case "client.next-appointment":
      return fromSchedule(sources, input.now, "next-appointment");
    case "workshop.builds":
      return fromBuilds(sources, "builds");
    case "workshop.assets":
      return fromAssets(sources, "assets");
    case "workshop.maintenance":
      return fromAssets(sources, "maintenance", input.now);
    case "crawler.status":
      return fromBuilds(sources, "crawler");
    case "trailer.status":
      return fromBuilds(sources, "trailer");
    default:
      return unavailable("No authoritative read is bound for this voice command.");
  }
}

async function fromInvoices(
  sources: AuthoritativeVoiceQuerySources,
  now: number,
): Promise<VoiceQueryAnswer> {
  const timezone = resolveZone(sources);
  if (isUnavailable(timezone)) return timezone;
  const invoices = await readList("Invoice records", () => sources.invoices.list());
  if (isUnavailable(invoices)) return invoices;
  return answered(invoicesAnswer(composeSlice(now, timezone, { invoices }).invoices));
}

async function fromEnquiries(
  sources: AuthoritativeVoiceQuerySources,
  now: number,
): Promise<VoiceQueryAnswer> {
  const timezone = resolveZone(sources);
  if (isUnavailable(timezone)) return timezone;
  const enquiries = await readList("Enquiry records", () =>
    sources.enquiries.list({ status: "open" }),
  );
  if (isUnavailable(enquiries)) return enquiries;
  return answered(enquiriesAnswer(composeSlice(now, timezone, { enquiries }).enquiries));
}

async function fromTasks(
  sources: AuthoritativeVoiceQuerySources,
  now: number,
): Promise<VoiceQueryAnswer> {
  const timezone = resolveZone(sources);
  if (isUnavailable(timezone)) return timezone;
  const tasks = await readList("Task records", () => sources.tasks.listTasks());
  if (isUnavailable(tasks)) return tasks;
  return answered(tasksAnswer(composeSlice(now, timezone, { tasks }).tasks));
}

async function fromReminders(
  sources: AuthoritativeVoiceQuerySources,
  now: number,
): Promise<VoiceQueryAnswer> {
  const timezone = resolveZone(sources);
  if (isUnavailable(timezone)) return timezone;
  const reminders = await readList("Reminder records", () => sources.reminders.listReminders());
  if (isUnavailable(reminders)) return reminders;
  return answered(
    remindersAnswer(composeSlice(now, timezone, { reminders }).reminders, reminders.length),
  );
}

async function fromErrands(
  sources: AuthoritativeVoiceQuerySources,
  now: number,
): Promise<VoiceQueryAnswer> {
  const timezone = resolveZone(sources);
  if (isUnavailable(timezone)) return timezone;
  const errands = await readList("Errand records", () => sources.errands.list());
  if (isUnavailable(errands)) return errands;
  return answered(errandsAnswer(composeSlice(now, timezone, { errands }).errands));
}

async function fromSchedule(
  sources: AuthoritativeVoiceQuerySources,
  now: number,
  kind: "today" | "week" | "next-job" | "next-appointment",
): Promise<VoiceQueryAnswer> {
  const timezone = resolveZone(sources);
  if (isUnavailable(timezone)) return timezone;
  const projects = await readList("Project records", () => sources.projects.list());
  if (isUnavailable(projects)) return projects;
  if (kind === "next-job" || kind === "next-appointment") {
    return answered(
      nextAnswer(
        nextBookedJob(projects, now, timezone),
        kind === "next-job" ? "job" : "appointment",
      ),
    );
  }
  const scheduled = composeSlice(now, timezone, { projects }).scheduled;
  return answered(kind === "today" ? todayAnswer(scheduled) : thisWeekAnswer(scheduled));
}

async function fromBuilds(
  sources: AuthoritativeVoiceQuerySources,
  kind: "builds" | "crawler" | "trailer",
): Promise<VoiceQueryAnswer> {
  const builds = await readList("Build records", () => sources.builds.list());
  if (isUnavailable(builds)) return builds;
  if (kind === "builds") return answered(buildsAnswer(builds));
  return answered(recordedStatus(builds, kind));
}

async function fromAssets(
  sources: AuthoritativeVoiceQuerySources,
  kind: "assets" | "maintenance",
  now = 0,
): Promise<VoiceQueryAnswer> {
  if (kind === "maintenance") {
    const timezone = resolveZone(sources);
    if (isUnavailable(timezone)) return timezone;
    const assets = await readList("Asset records", () => sources.assets.list());
    if (isUnavailable(assets)) return assets;
    return answered(maintenanceAnswer(composeSlice(now, timezone, { assets }).maintenance));
  }
  const assets = await readList("Asset records", () => sources.assets.list());
  if (isUnavailable(assets)) return assets;
  return answered(assetsAnswer(assets));
}
