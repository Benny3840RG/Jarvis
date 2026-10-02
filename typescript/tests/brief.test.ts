import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BRIEF_HIGHLIGHT_LIMIT,
  BRIEF_UPCOMING_WINDOW_MS,
  composeDailyBrief,
  isoWeekRange,
  operatorLocalDate,
} from "../src/briefs/brief.js";
import type { Asset } from "../src/assets/asset.js";
import type { Enquiry, EnquiryStatus, EnquiryUrgency } from "../src/enquiries/enquiry.js";
import type { Errand, ErrandStatus } from "../src/errands/errand.js";
import type { Invoice, InvoiceStatus } from "../src/invoices/invoice.js";
import type { Reminder, Task } from "../src/persistence/types.js";
import type { Project } from "../src/projects/project.js";
import type { Quote, QuoteStatus } from "../src/quotes/quote.js";

const NOW = Date.UTC(2026, 6, 21, 8, 0, 0);
const MS_PER_DAY = 86_400_000;

function asset(id: string, serviceIntervalDays?: number, lastServicedAt?: number): Asset {
  return {
    id,
    name: `Asset ${id}`,
    kind: "machine",
    ...(serviceIntervalDays === undefined ? {} : { serviceIntervalDays }),
    ...(lastServicedAt === undefined ? {} : { lastServicedAt }),
    createdAt: 1,
    updatedAt: 1,
  };
}

function task(id: string, createdAt: number, completed = false): Task {
  return { id, title: `Task ${id}`, completed, category: "general", createdAt };
}

function reminder(id: string, dueAt?: number): Reminder {
  return {
    id,
    title: `Reminder ${id}`,
    ...(dueAt === undefined
      ? {}
      : { dueAt, dueRaw: "due soon", dueTimezone: "Australia/Melbourne" }),
    createdAt: 1,
  };
}

function project(id: string, status: Project["status"], updatedAt: number): Project {
  return { id, clientId: "c1", title: `Project ${id}`, status, createdAt: 1, updatedAt };
}

function quote(id: string, status: QuoteStatus, total: number, updatedAt = 1): Quote {
  return {
    id,
    clientId: "c1",
    number: `Q-${id}`,
    status,
    lineItems: [{ description: "Work", quantity: 1, unitPrice: total }],
    subtotal: total,
    tax: 0,
    total,
    createdAt: 1,
    updatedAt,
  };
}

function enquiry(
  id: string,
  urgency: EnquiryUrgency,
  createdAt: number,
  status: EnquiryStatus = "open",
): Enquiry {
  return {
    id,
    clientId: "c1",
    source: "phone",
    requestedWork: `Work ${id}`,
    urgency,
    attachmentRefs: [],
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

function invoice(
  id: string,
  status: InvoiceStatus,
  total: number,
  amountPaid: number,
  issuedAt?: number,
): Invoice {
  const balanceDue = total - amountPaid;
  return {
    id,
    clientId: "c1",
    number: `INV-${id}`,
    status,
    lineItems: [{ description: "Work", quantity: 1, unitPrice: total }],
    subtotal: total,
    tax: 0,
    total,
    amountPaid,
    balanceDue,
    paymentStatus: amountPaid === 0 ? "unpaid" : balanceDue > 0 ? "partial" : "paid",
    payments: [],
    ...(issuedAt === undefined ? {} : { issuedAt }),
    createdAt: 1,
    updatedAt: 1,
  };
}

function errand(
  id: string,
  status: ErrandStatus,
  createdAt: number,
  locationLabel?: string,
): Errand {
  return {
    id,
    title: `Errand ${id}`,
    status,
    ...(locationLabel === undefined ? {} : { location: { label: locationLabel } }),
    createdAt,
    updatedAt: createdAt,
  };
}

function baseInputs() {
  return {
    now: NOW,
    timezone: "Australia/Melbourne",
    tasks: [] as Task[],
    reminders: [] as Reminder[],
    projects: [] as Project[],
    quotes: [] as Quote[],
    assets: [] as Asset[],
    enquiries: [] as Enquiry[],
    invoices: [] as Invoice[],
    errands: [] as Errand[],
  };
}

describe("composeDailyBrief", () => {
  it("counts and caps open tasks, oldest first", () => {
    const tasks = [
      ...Array.from({ length: 7 }, (_, index) => task(`open-${index}`, 100 - index)),
      task("done-1", 1, true),
      task("done-2", 2, true),
    ];
    const brief = composeDailyBrief({ ...baseInputs(), tasks });
    assert.equal(brief.tasks.openCount, 7);
    assert.equal(brief.tasks.completedCount, 2);
    assert.equal(brief.tasks.open.length, BRIEF_HIGHLIGHT_LIMIT);
    // Oldest (lowest createdAt) surfaces first: the longest-outstanding work.
    assert.equal(brief.tasks.open[0].id, "open-6");
    const stamps = brief.tasks.open.map((entry) => entry.createdAt);
    assert.deepEqual(
      stamps,
      [...stamps].sort((a, b) => a - b),
    );
  });

  it("splits reminders into due, upcoming within 24h, and undated", () => {
    const reminders = [
      reminder("overdue", NOW - 1000),
      reminder("later-today", NOW + 60 * 60 * 1000),
      reminder("beyond-window", NOW + BRIEF_UPCOMING_WINDOW_MS + 1),
      reminder("undated"),
    ];
    const brief = composeDailyBrief({ ...baseInputs(), reminders });
    assert.equal(brief.reminders.dueCount, 1);
    assert.equal(brief.reminders.due[0].id, "overdue");
    assert.equal(brief.reminders.upcomingCount, 1);
    assert.equal(brief.reminders.upcoming[0].id, "later-today");
    assert.equal(brief.reminders.undatedCount, 1);
  });

  it("summarises projects by status with active ones most recently touched first", () => {
    const projects = [
      project("p1", "active", 10),
      project("p2", "active", 30),
      project("p3", "lead", 5),
      project("p4", "done", 50),
    ];
    const brief = composeDailyBrief({ ...baseInputs(), projects });
    assert.equal(brief.projects.activeCount, 2);
    assert.deepEqual(brief.projects.countsByStatus, {
      lead: 1,
      quoted: 0,
      active: 2,
      on_hold: 0,
      done: 1,
    });
    assert.deepEqual(
      brief.projects.active.map((entry) => entry.id),
      ["p2", "p1"],
    );
  });

  it("buckets booked jobs into today, later this week, and unscheduled active", () => {
    // NOW is 2026-07-21 18:00 in Melbourne (Tuesday); its Mon–Sun week ends 2026-07-26.
    const booked = (
      id: string,
      status: Project["status"],
      scheduledFor: string,
      updatedAt = 1,
    ) => ({
      ...project(id, status, updatedAt),
      scheduledFor,
    });
    const projects = [
      booked("today-active", "active", "2026-07-21", 10),
      booked("today-quoted", "quoted", "2026-07-21", 20),
      booked("week-wed", "active", "2026-07-22", 5),
      booked("week-sun", "lead", "2026-07-26", 5), // Sunday boundary is in the week
      booked("next-mon", "active", "2026-07-27", 5), // next week is excluded
      booked("past", "active", "2026-07-20", 5), // earlier today-week day, already gone
      booked("done-today", "done", "2026-07-21", 5), // done jobs are not surfaced
      project("unsched-active", "active", 30), // active, no date -> unscheduled
      project("unsched-lead", "lead", 40), // only active counts as unscheduled
    ];
    const brief = composeDailyBrief({ ...baseInputs(), projects });
    assert.equal(brief.scheduled.todayCount, 2);
    // Same day: most recently updated first.
    assert.deepEqual(
      brief.scheduled.today.map((entry) => entry.id),
      ["today-quoted", "today-active"],
    );
    assert.equal(brief.scheduled.thisWeekCount, 2);
    // Soonest booked day first.
    assert.deepEqual(
      brief.scheduled.thisWeek.map((entry) => entry.id),
      ["week-wed", "week-sun"],
    );
    assert.equal(brief.scheduled.unscheduledCount, 1);
    assert.deepEqual(
      brief.scheduled.unscheduled.map((entry) => entry.id),
      ["unsched-active"],
    );
    // "past" is booked before today and not done -> overdue; "done-today" is excluded.
    assert.equal(brief.scheduled.overdueCount, 1);
    assert.deepEqual(
      brief.scheduled.overdue.map((entry) => entry.id),
      ["past"],
    );
  });

  it("derives the local booking day from the timezone, not UTC", () => {
    // 2026-07-21 20:00 UTC is already 2026-07-22 06:00 in Melbourne (+10).
    const now = Date.UTC(2026, 6, 21, 20, 0, 0);
    const booked = (id: string, scheduledFor: string) => ({
      ...project(id, "active", 1),
      scheduledFor,
    });
    const brief = composeDailyBrief({
      ...baseInputs(),
      now,
      projects: [booked("tomorrow-utc", "2026-07-22"), booked("today-utc", "2026-07-21")],
    });
    assert.equal(brief.scheduled.todayCount, 1);
    assert.deepEqual(
      brief.scheduled.today.map((entry) => entry.id),
      ["tomorrow-utc"],
    );
  });

  it("applies the operator timezone's DST offset when resolving the local date", () => {
    // Same 13:30 UTC wall time, six months apart: Melbourne is AEDT (+11) in
    // January and AEST (+10) in July, so the local calendar date differs.
    assert.equal(
      operatorLocalDate(Date.UTC(2026, 0, 14, 13, 30, 0), "Australia/Melbourne"),
      "2026-01-15",
    );
    assert.equal(
      operatorLocalDate(Date.UTC(2026, 6, 14, 13, 30, 0), "Australia/Melbourne"),
      "2026-07-14",
    );
    // UTC itself has no DST: both resolve to the UTC calendar day.
    assert.equal(operatorLocalDate(Date.UTC(2026, 0, 14, 13, 30, 0), "UTC"), "2026-01-14");
  });

  it("computes the Monday–Sunday week, including across a year boundary", () => {
    assert.deepEqual(isoWeekRange("2026-07-21"), { start: "2026-07-20", end: "2026-07-26" });
    assert.deepEqual(isoWeekRange("2026-07-20"), { start: "2026-07-20", end: "2026-07-26" }); // Monday
    assert.deepEqual(isoWeekRange("2026-07-26"), { start: "2026-07-20", end: "2026-07-26" }); // Sunday
    assert.deepEqual(isoWeekRange("2027-01-01"), { start: "2026-12-28", end: "2027-01-03" }); // Friday
  });

  it("treats a Sunday with nothing left this week as an empty week bucket", () => {
    // 2026-07-26 12:00 Melbourne is a Sunday; the week has no days after today.
    const now = Date.UTC(2026, 6, 26, 2, 0, 0);
    const booked = (id: string, scheduledFor: string) => ({
      ...project(id, "active", 1),
      scheduledFor,
    });
    const brief = composeDailyBrief({
      ...baseInputs(),
      now,
      projects: [booked("sunday", "2026-07-26"), booked("next-mon", "2026-07-27")],
    });
    assert.equal(brief.scheduled.todayCount, 1);
    assert.equal(brief.scheduled.thisWeekCount, 0);
  });

  it("caps booked-today highlights and stays empty with no projects", () => {
    const booked = Array.from({ length: 7 }, (_, index) => ({
      ...project(`b-${index}`, "active", index),
      scheduledFor: "2026-07-21",
    }));
    const brief = composeDailyBrief({ ...baseInputs(), projects: booked });
    assert.equal(brief.scheduled.todayCount, 7);
    assert.equal(brief.scheduled.today.length, BRIEF_HIGHLIGHT_LIMIT);

    const empty = composeDailyBrief({ ...baseInputs() });
    assert.equal(empty.scheduled.overdueCount, 0);
    assert.equal(empty.scheduled.todayCount, 0);
    assert.equal(empty.scheduled.thisWeekCount, 0);
    assert.equal(empty.scheduled.unscheduledCount, 0);
    assert.deepEqual(empty.scheduled.overdue, []);
    assert.deepEqual(empty.scheduled.today, []);
  });

  it("surfaces booked-but-not-done jobs as overdue, most overdue first", () => {
    // NOW is local 2026-07-21; anything booked before today that is not done is overdue.
    const booked = (
      id: string,
      status: Project["status"],
      scheduledFor: string,
      updatedAt = 1,
    ) => ({
      ...project(id, status, updatedAt),
      scheduledFor,
    });
    const projects = [
      booked("yesterday", "active", "2026-07-20", 5),
      booked("last-week", "quoted", "2026-07-14", 9),
      booked("on-hold-past", "on_hold", "2026-07-01", 3),
      booked("today", "active", "2026-07-21", 7), // today is not overdue
      booked("done-past", "done", "2026-07-10", 2), // done is never overdue
    ];
    const brief = composeDailyBrief({ ...baseInputs(), projects });
    assert.equal(brief.scheduled.overdueCount, 3);
    // Earliest booked day first = most overdue first.
    assert.deepEqual(
      brief.scheduled.overdue.map((entry) => entry.id),
      ["on-hold-past", "last-week", "yesterday"],
    );
    assert.equal(brief.scheduled.todayCount, 1);
  });

  it("derives quote pipeline and accepted totals from real quote totals", () => {
    const quotes = [
      quote("a", "sent", 110.1, 20),
      quote("b", "sent", 220.25, 40),
      quote("c", "accepted", 550),
      quote("d", "draft", 90),
      quote("e", "declined", 10),
    ];
    const brief = composeDailyBrief({ ...baseInputs(), quotes });
    assert.deepEqual(brief.quotes.countsByStatus, { draft: 1, sent: 2, accepted: 1, declined: 1 });
    assert.equal(brief.quotes.pipelineTotal, 330.35);
    assert.equal(brief.quotes.acceptedTotal, 550);
    assert.deepEqual(
      brief.quotes.awaitingResponse.map((entry) => entry.id),
      ["b", "a"],
    );
    assert.deepEqual(
      brief.quotes.drafts.map((entry) => entry.id),
      ["d"],
    );
  });

  it("writes an honest headline and stamps generation time and timezone", () => {
    const brief = composeDailyBrief({
      ...baseInputs(),
      tasks: [task("t1", 1)],
      reminders: [reminder("r1", NOW - 1)],
      projects: [project("p1", "active", 1)],
      quotes: [quote("q1", "sent", 100)],
    });
    assert.equal(
      brief.headline,
      "1 open task, 1 reminder due, 1 active project, 1 quote awaiting response, 0 open enquiries, 0 invoices unpaid, 0 errands to run.",
    );
    assert.equal(brief.generatedAt, new Date(NOW).toISOString());
    assert.equal(brief.timezone, "Australia/Melbourne");
  });

  it("pluralises the headline and stays calm when everything is empty", () => {
    const brief = composeDailyBrief(baseInputs());
    assert.equal(
      brief.headline,
      "0 open tasks, 0 reminders due, 0 active projects, 0 quotes awaiting response, 0 open enquiries, 0 invoices unpaid, 0 errands to run.",
    );
    assert.deepEqual(brief.tasks.open, []);
    assert.deepEqual(brief.enquiries.open, []);
    assert.deepEqual(brief.invoices.unpaid, []);
    assert.equal(brief.invoices.unpaidTotal, 0);
    assert.equal(brief.quotes.pipelineTotal, 0);
    assert.equal(brief.maintenance.dueCount, 0);
    assert.equal(brief.maintenance.dueSoonCount, 0);
  });

  it("surfaces assets that are overdue or due soon in the maintenance section", () => {
    const brief = composeDailyBrief({
      ...baseInputs(),
      assets: [
        // Overdue: serviced 40 days ago on a 30-day interval.
        asset("overdue", 30, NOW - 40 * MS_PER_DAY),
        // Due soon: serviced 3 days ago on a 10-day interval (next due in 7 days).
        asset("soon", 10, NOW - 3 * MS_PER_DAY),
        // Not due: serviced today on a 365-day interval.
        asset("fresh", 365, NOW),
        // No schedule: never counts.
        asset("unscheduled"),
      ],
    });
    assert.equal(brief.maintenance.dueCount, 1);
    assert.equal(brief.maintenance.due[0].id, "overdue");
    assert.equal(brief.maintenance.due[0].due, true);
    assert.equal(brief.maintenance.dueSoonCount, 1);
    assert.equal(brief.maintenance.dueSoon[0].id, "soon");
    assert.equal(brief.maintenance.dueSoon[0].due, false);
  });

  it("lists open enquiries most urgent first, then longest waiting, and caps them", () => {
    const brief = composeDailyBrief({
      ...baseInputs(),
      enquiries: [
        enquiry("std-old", "standard", 10),
        enquiry("std-new", "standard", 50),
        enquiry("urgent", "urgent", 40),
        enquiry("emergency", "emergency", 60),
        enquiry("closed", "emergency", 1, "closed"),
        enquiry("converted", "urgent", 1, "converted"),
        ...Array.from({ length: 4 }, (_, index) =>
          enquiry(`extra-${index}`, "standard", 100 + index),
        ),
      ],
    });
    assert.equal(brief.enquiries.openCount, 8);
    assert.deepEqual(brief.enquiries.countsByUrgency, { standard: 6, urgent: 1, emergency: 1 });
    assert.equal(brief.enquiries.open.length, BRIEF_HIGHLIGHT_LIMIT);
    assert.deepEqual(
      brief.enquiries.open.map((item) => item.id),
      ["emergency", "urgent", "std-old", "std-new", "extra-0"],
    );
    assert.match(brief.headline, /8 open enquiries/);
  });

  it("totals unpaid issued invoices, oldest issue first, and counts drafts separately", () => {
    const brief = composeDailyBrief({
      ...baseInputs(),
      invoices: [
        invoice("draft", "draft", 500, 0),
        invoice("recent", "issued", 300, 0, 900),
        invoice("partial", "issued", 1000.1, 400.05, 100),
        invoice("paid", "paid", 200, 200, 50),
        invoice("void", "void", 700, 0, 20),
        invoice("issued-settled", "issued", 100, 100, 30),
      ],
    });
    assert.equal(brief.invoices.draftCount, 1);
    assert.equal(brief.invoices.unpaidCount, 2);
    assert.deepEqual(
      brief.invoices.unpaid.map((item) => item.id),
      ["partial", "recent"],
    );
    assert.equal(brief.invoices.unpaidTotal, 900.05, "sums balanceDue, rounded to cents");
    assert.match(brief.headline, /2 invoices unpaid, 0 errands to run\.$/);
  });

  it("lists open errands located first by place then oldest, and counts distinct places", () => {
    const brief = composeDailyBrief({
      ...baseInputs(),
      errands: [
        errand("done", "done", 1, "Bunnings Frankston"),
        errand("bunnings-late", "open", 5, "Bunnings Frankston"),
        errand("bunnings-early", "open", 3, "Bunnings Frankston"),
        errand("mitre", "open", 2, "Mitre 10"),
        errand("no-place", "open", 4),
      ],
    });
    assert.equal(brief.errands.openCount, 4);
    assert.equal(brief.errands.locationCount, 2, "Bunnings Frankston and Mitre 10");
    assert.deepEqual(
      brief.errands.open.map((item) => item.id),
      ["bunnings-early", "bunnings-late", "mitre", "no-place"],
      "located grouped by place, oldest first within a place, unlocated last",
    );
    assert.match(brief.headline, /4 errands to run\.$/);
  });

  it("caps the open errands list at the highlight limit", () => {
    const brief = composeDailyBrief({
      ...baseInputs(),
      errands: Array.from({ length: BRIEF_HIGHLIGHT_LIMIT + 3 }, (_, index) =>
        errand(`e-${index}`, "open", index + 1),
      ),
    });
    assert.equal(brief.errands.openCount, BRIEF_HIGHLIGHT_LIMIT + 3);
    assert.equal(brief.errands.open.length, BRIEF_HIGHLIGHT_LIMIT);
  });

  it("uses singular wording for one enquiry, one unpaid invoice, and one errand", () => {
    const brief = composeDailyBrief({
      ...baseInputs(),
      enquiries: [enquiry("e1", "standard", 1)],
      invoices: [invoice("i1", "issued", 50, 0, 1)],
      errands: [errand("x1", "open", 1, "Bunnings Frankston")],
    });
    assert.match(brief.headline, /1 open enquiry, 1 invoice unpaid, 1 errand to run\.$/);
  });
});
