/**
 * Voice query adapter over the read models the HTTP brief and domain stores
 * already expose. List methods only. No writes, no raw storage, no second
 * business definition of unpaid, open, due, or scheduled.
 */

import type { Asset, AssetStore } from "../assets/asset.js";
import {
  composeDailyBrief,
  nextBookedJob,
  operatorLocalDate,
  type BriefErrands,
  type BriefEnquiries,
  type BriefInvoices,
  type BriefMaintenance,
  type BriefReminders,
  type BriefScheduled,
  type BriefTasks,
  type DailyBrief,
} from "../briefs/brief.js";
import { spokenCount, spokenList, spokenTime, spokenWhen, withList } from "./spokenAnswer.js";
import type { Build, BuildStore } from "../builds/build.js";
import type { Enquiry, EnquiryStore } from "../enquiries/enquiry.js";
import type { Errand, ErrandStore } from "../errands/errand.js";
import type { Invoice, InvoiceStore } from "../invoices/invoice.js";
import type { PersistenceProvider, Reminder, Task } from "../persistence/persistence.js";
import type { Project, ProjectStore } from "../projects/project.js";
import type { Quote, QuoteStore } from "../quotes/quote.js";
import { resolveReminderTimezone } from "../reminders/due.js";
import type { VoiceQueryAnswer, VoiceQueryProvider, VoiceQueryRequest } from "./voiceQuery.js";
import { DAILY_RUNDOWN_COMMAND_ID, TOMORROW_RUNDOWN_COMMAND_ID } from "./voiceRundown.js";

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

const AUD = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });

function invoicesAnswer(invoices: BriefInvoices): string {
  if (invoices.unpaidCount === 0) return "No unpaid invoices.";
  return withList(
    `${capitalise(spokenCount(invoices.unpaidCount, "unpaid invoice"))}, ${AUD.format(invoices.unpaidTotal)} owing`,
    invoices.unpaid.map((invoice) => invoice.number),
    invoices.unpaidCount,
  );
}

/** "2026-10-12" → "Monday 12 October"; anything else is read as recorded. */
function spokenDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const instant = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  })
    .format(new Date(instant))
    .replace(",", "");
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function enquiriesAnswer(enquiries: BriefEnquiries): string {
  if (enquiries.openCount === 0) return "No new enquiries waiting.";
  return withList(
    `${capitalise(spokenCount(enquiries.openCount, "enquiry", "enquiries"))} waiting`,
    enquiries.open.map((enquiry) => enquiry.requestedWork),
    enquiries.openCount,
  );
}

function tasksAnswer(tasks: BriefTasks): string {
  if (tasks.openCount === 0) return "Your task list is clear.";
  return withList(
    `You've got ${spokenCount(tasks.openCount, "task")}`,
    tasks.open.map((task) => task.title),
    tasks.openCount,
  );
}

/** Every reminder, soonest first, with when it is due ("Send quote, Friday at 9 am"). */
function remindersAnswer(reminders: readonly Reminder[], now: number, timezone: string): string {
  if (reminders.length === 0) return "You haven't got any reminders.";
  const dated = reminders
    .filter(
      (reminder): reminder is Reminder & { dueAt: number } => typeof reminder.dueAt === "number",
    )
    .sort((a, b) => a.dueAt - b.dueAt);
  const undated = reminders.filter((reminder) => typeof reminder.dueAt !== "number");
  const overdue = dated.filter((reminder) => reminder.dueAt <= now);
  const ahead = dated.filter((reminder) => reminder.dueAt > now);
  const sentences: string[] = [];
  if (overdue.length > 0) {
    sentences.push(
      withList(
        overdue.length === 1
          ? "One's overdue"
          : `${capitalise(spokenCount(overdue.length, "is", "are"))} overdue`,
        overdue.slice(0, HIGHLIGHT_LIMIT).map((reminder) => reminder.title),
        overdue.length,
      ),
    );
  }
  if (ahead.length > 0) {
    const shown = ahead
      .slice(0, HIGHLIGHT_LIMIT)
      .map((reminder) => `${reminder.title}, ${spokenWhen(reminder.dueAt, now, timezone)}`);
    sentences.push(withList(overdue.length > 0 ? "Coming up" : "Next up", shown, ahead.length));
  }
  // A reminder with no worked-out time still carries what the owner said ("Friday 9am").
  const undatedNames = undated
    .slice(0, HIGHLIGHT_LIMIT)
    .map((reminder) =>
      reminder.dueRaw?.trim() ? `${reminder.title}, for ${reminder.dueRaw.trim()}` : reminder.title,
    );
  if (sentences.length === 0) {
    return withList(
      `You've got ${spokenCount(reminders.length, "reminder")}`,
      undatedNames,
      undated.length,
    );
  }
  if (undated.length > 0) {
    sentences.push(
      withList(
        `And ${spokenCount(undated.length, "with no exact time", "with no exact time")}`,
        undatedNames,
        undated.length,
      ),
    );
  }
  return `You've got ${spokenCount(reminders.length, "reminder")}. ${sentences.join(" ")}`;
}

function errandsAnswer(errands: BriefErrands): string {
  if (errands.openCount === 0) return "No errands to run.";
  return withList(
    `You've got ${spokenCount(errands.openCount, "errand")} to run`,
    errands.open.map((errand) =>
      errand.location?.label ? `${errand.title} at ${errand.location.label}` : errand.title,
    ),
    errands.openCount,
  );
}

function todayAnswer(scheduled: BriefScheduled): string {
  if (scheduled.todayCount === 0) return "Nothing's booked in for today.";
  return withList(
    `You've got ${spokenCount(scheduled.todayCount, "job")} booked today`,
    scheduled.today.map((project) => project.title),
    scheduled.todayCount,
  );
}

function thisWeekAnswer(scheduled: BriefScheduled): string {
  if (scheduled.todayCount === 0 && scheduled.thisWeekCount === 0) {
    return "Nothing's booked in for the rest of the week.";
  }
  const sentences: string[] = [];
  sentences.push(
    scheduled.todayCount === 0
      ? "Nothing today."
      : withList(
          `Today, ${spokenCount(scheduled.todayCount, "job")}`,
          scheduled.today.map((project) => project.title),
          scheduled.todayCount,
        ),
  );
  sentences.push(
    scheduled.thisWeekCount === 0
      ? "Nothing else later this week."
      : withList(
          `Later this week, ${spokenCount(scheduled.thisWeekCount, "job")}`,
          scheduled.thisWeek.map((project) => project.title),
          scheduled.thisWeekCount,
        ),
  );
  return sentences.join(" ");
}

function nextAnswer(
  job: (Project & { scheduledFor: string }) | undefined,
  kind: "job" | "appointment",
): string {
  if (!job) {
    return kind === "job"
      ? "There's no job booked in yet."
      : "There's no appointment booked in yet.";
  }
  const lead = kind === "job" ? "Your next job is" : "Your next appointment is";
  const time = kind === "appointment" ? " I don't have a time for it." : "";
  return `${lead} ${job.title}, booked for ${spokenDate(job.scheduledFor)}.${time}`;
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
    case DAILY_RUNDOWN_COMMAND_ID:
      return fromRundown(sources, input.now);
    case TOMORROW_RUNDOWN_COMMAND_ID:
      return fromTomorrow(sources, input.now);
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
  return answered(remindersAnswer(reminders, now, timezone));
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

/** The rundown's reminder sentence, or null when nothing is due or coming up today. */
function rundownRemindersAnswer(
  reminders: BriefReminders,
  now: number,
  timezone: string,
): string | null {
  if (reminders.dueCount === 0 && reminders.upcomingCount === 0) return null;
  const sentences: string[] = [];
  if (reminders.dueCount > 0) {
    sentences.push(
      withList(
        reminders.dueCount === 1
          ? "One reminder's overdue"
          : `${capitalise(spokenCount(reminders.dueCount, "reminder"))} are overdue`,
        reminders.due.map((reminder) => reminder.title),
        reminders.dueCount,
      ),
    );
  }
  if (reminders.upcomingCount > 0) {
    sentences.push(
      withList(
        "Coming up",
        reminders.upcoming.map((reminder) =>
          typeof reminder.dueAt === "number"
            ? `${reminder.title}, ${spokenWhen(reminder.dueAt, now, timezone)}`
            : reminder.title,
        ),
        reminders.upcomingCount,
      ),
    );
  }
  return sentences.join(" ");
}

/**
 * The spoken daily rundown: today's jobs, reminders due or coming up, open
 * tasks and open errands, each from the same read model as its own query.
 * A source that cannot be read is named in its place, never guessed; if no
 * source can be read the whole rundown is unavailable.
 */
async function fromRundown(
  sources: AuthoritativeVoiceQuerySources,
  now: number,
): Promise<VoiceQueryAnswer> {
  const timezone = resolveZone(sources);
  if (isUnavailable(timezone)) return timezone;
  const [projects, reminders, tasks, errands] = await Promise.all([
    readList("Project records", () => sources.projects.list()),
    readList("Reminder records", () => sources.reminders.listReminders()),
    readList("Task records", () => sources.tasks.listTasks()),
    readList("Errand records", () => sources.errands.list()),
  ]);
  if ([projects, reminders, tasks, errands].every(isUnavailable)) {
    return unavailable("The daily rundown is unavailable: no source could be read.");
  }
  const said: string[] = [];
  const nothing: string[] = [];
  const add = (part: string | null | VoiceQueryAnswer, noun: string) => {
    if (part === null) nothing.push(noun);
    else said.push(typeof part === "string" ? part : (part as { reason: string }).reason);
  };
  if (isUnavailable(projects)) add(projects, "jobs");
  else {
    const scheduled = composeSlice(now, timezone, { projects }).scheduled;
    add(
      scheduled.todayCount === 0
        ? null
        : withList(
            `${capitalise(spokenCount(scheduled.todayCount, "job"))} booked`,
            scheduled.today.map((project) => project.title),
            scheduled.todayCount,
          ),
      "jobs",
    );
  }
  if (isUnavailable(reminders)) add(reminders, "reminders");
  else
    add(
      rundownRemindersAnswer(composeSlice(now, timezone, { reminders }).reminders, now, timezone),
      "reminders",
    );
  if (isUnavailable(tasks)) add(tasks, "tasks");
  else {
    const open = composeSlice(now, timezone, { tasks }).tasks;
    add(
      open.openCount === 0
        ? null
        : withList(
            `${capitalise(spokenCount(open.openCount, "task"))} on your list`,
            open.open.map((task) => task.title),
            open.openCount,
          ),
      "tasks",
    );
  }
  if (isUnavailable(errands)) add(errands, "errands");
  else {
    const open = composeSlice(now, timezone, { errands }).errands;
    add(
      open.openCount === 0
        ? null
        : withList(
            `${capitalise(spokenCount(open.openCount, "errand"))} to run`,
            open.open.map((errand) =>
              errand.location?.label ? `${errand.title} at ${errand.location.label}` : errand.title,
            ),
            open.openCount,
          ),
      "errands",
    );
  }
  if (said.length === 0) {
    return answered(
      "You're all clear today. No jobs booked, nothing on your list, no errands and no reminders coming up.",
    );
  }
  const none = nothing.length > 0 ? ` No ${spokenList(nothing, nothing.length, "or")}.` : "";
  return answered(`Here's your day. ${said.join(" ")}${none}`);
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

/** The calendar day after an ISO `YYYY-MM-DD` date (calendar maths only, no zone). */
function nextCalendarDay(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
}

/**
 * "What have I got on tomorrow": jobs booked for tomorrow and reminders due
 * tomorrow in the owner's timezone, each from the same records as the daily
 * rundown. A source that cannot be read is named, never guessed.
 */
async function fromTomorrow(
  sources: AuthoritativeVoiceQuerySources,
  now: number,
): Promise<VoiceQueryAnswer> {
  const timezone = resolveZone(sources);
  if (isUnavailable(timezone)) return timezone;
  const [projects, reminders] = await Promise.all([
    readList("Project records", () => sources.projects.list()),
    readList("Reminder records", () => sources.reminders.listReminders()),
  ]);
  if (isUnavailable(projects) && isUnavailable(reminders)) {
    return unavailable("Tomorrow's rundown is unavailable: no source could be read.");
  }
  const tomorrow = nextCalendarDay(operatorLocalDate(now, timezone));
  const said: string[] = [];
  const nothing: string[] = [];
  if (isUnavailable(projects)) said.push((projects as { reason: string }).reason);
  else {
    const jobs = projects.filter(
      (project) => project.status !== "done" && project.scheduledFor === tomorrow,
    );
    if (jobs.length === 0) nothing.push("jobs");
    else
      said.push(
        withList(
          `${capitalise(spokenCount(jobs.length, "job"))} booked`,
          jobs.slice(0, HIGHLIGHT_LIMIT).map((job) => job.title),
          jobs.length,
        ),
      );
  }
  if (isUnavailable(reminders)) said.push((reminders as { reason: string }).reason);
  else {
    const due = reminders
      .filter(
        (reminder): reminder is Reminder & { dueAt: number } =>
          typeof reminder.dueAt === "number" &&
          reminder.dueAt > now &&
          operatorLocalDate(reminder.dueAt, timezone) === tomorrow,
      )
      .sort((a, b) => a.dueAt - b.dueAt);
    if (due.length === 0) nothing.push("reminders");
    else
      said.push(
        withList(
          due.length === 1 ? "One reminder" : `${capitalise(spokenCount(due.length, "reminder"))}`,
          due
            .slice(0, HIGHLIGHT_LIMIT)
            .map((reminder) => `${reminder.title} at ${spokenTime(reminder.dueAt, timezone)}`),
          due.length,
        ),
      );
  }
  if (said.length === 0)
    return answered("Nothing on for tomorrow yet. No jobs booked and no reminders.");
  const none = nothing.length > 0 ? ` No ${spokenList(nothing, nothing.length, "or")}.` : "";
  return answered(`Here's tomorrow. ${said.join(" ")}${none}`);
}
