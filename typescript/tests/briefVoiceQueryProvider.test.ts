import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type DailyBrief } from "../src/briefs/brief.js";
import { ENQUIRY_URGENCIES } from "../src/enquiries/enquiry.js";
import type { Project, ProjectStatus } from "../src/projects/project.js";
import { PROJECT_STATUSES } from "../src/projects/project.js";
import { QUOTE_STATUSES } from "../src/quotes/quote.js";
import { DailyBriefVoiceQueryProvider } from "../src/voice/briefVoiceQueryProvider.js";

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

function job(title: string, scheduledFor?: string): Project {
  return {
    id: title,
    clientId: "c1",
    title,
    status: "active" as ProjectStatus,
    ...(scheduledFor ? { scheduledFor } : {}),
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A complete but empty brief; tests override only the sections they read. */
function emptyBrief(): DailyBrief {
  return {
    generatedAt: "2026-10-11T00:00:00.000Z",
    timezone: "UTC",
    headline: "",
    tasks: { openCount: 0, completedCount: 0, open: [] },
    reminders: { dueCount: 0, upcomingCount: 0, undatedCount: 0, due: [], upcoming: [] },
    projects: { activeCount: 0, countsByStatus: zeroed(PROJECT_STATUSES), active: [] },
    quotes: {
      countsByStatus: zeroed(QUOTE_STATUSES),
      pipelineTotal: 0,
      acceptedTotal: 0,
      awaitingResponse: [],
      drafts: [],
    },
    maintenance: { dueCount: 0, dueSoonCount: 0, due: [], dueSoon: [] },
    enquiries: { openCount: 0, countsByUrgency: zeroed(ENQUIRY_URGENCIES), open: [] },
    invoices: { draftCount: 0, unpaidCount: 0, unpaidTotal: 0, unpaid: [] },
    errands: { openCount: 0, locationCount: 0, open: [] },
    scheduled: {
      overdueCount: 0,
      todayCount: 0,
      thisWeekCount: 0,
      unscheduledCount: 0,
      overdue: [],
      today: [],
      thisWeek: [],
      unscheduled: [],
    },
  };
}

function providerFor(brief: DailyBrief): DailyBriefVoiceQueryProvider {
  return new DailyBriefVoiceQueryProvider(async () => brief);
}

async function answerOf(brief: DailyBrief, commandId: string, profile: "client" | "workshop") {
  return providerFor(brief).answer({ commandId, profile });
}

describe("DailyBriefVoiceQueryProvider — business queries", () => {
  it("reports unpaid invoices by count, singular and plural", async () => {
    const none = await answerOf(emptyBrief(), "client.unpaid-invoices", "client");
    assert.deepEqual(none, {
      status: "answered",
      commandId: "client.unpaid-invoices",
      answer: "No unpaid invoices.",
    });

    const one = emptyBrief();
    one.invoices.unpaidCount = 1;
    const oneAns = await answerOf(one, "client.unpaid-invoices", "client");
    assert.equal(oneAns.status === "answered" && oneAns.answer, "1 unpaid invoice.");

    const many = emptyBrief();
    many.invoices.unpaidCount = 3;
    const manyAns = await answerOf(many, "client.unpaid-invoices", "client");
    assert.equal(manyAns.status === "answered" && manyAns.answer, "3 unpaid invoices.");
  });

  it("reports open enquiries with correct pluralisation", async () => {
    const one = emptyBrief();
    one.enquiries.openCount = 1;
    const oneAns = await answerOf(one, "client.open-enquiries", "client");
    assert.equal(oneAns.status === "answered" && oneAns.answer, "1 open enquiry.");

    const many = emptyBrief();
    many.enquiries.openCount = 2;
    const manyAns = await answerOf(many, "client.open-enquiries", "client");
    assert.equal(manyAns.status === "answered" && manyAns.answer, "2 open enquiries.");
  });

  it("reads out today's schedule, naming jobs and collapsing the remainder", async () => {
    const empty = await answerOf(emptyBrief(), "client.todays-schedule", "client");
    assert.equal(empty.status === "answered" && empty.answer, "Nothing scheduled for today.");

    const b = emptyBrief();
    b.scheduled.todayCount = 4;
    b.scheduled.today = [
      job("Gutter clean"),
      job("Fascia repair"),
      job("Moss treat"),
      job("Survey"),
    ];
    const ans = await answerOf(b, "client.todays-schedule", "client");
    assert.equal(
      ans.status === "answered" && ans.answer,
      "4 jobs today: Gutter clean, Fascia repair, Moss treat, and 1 more.",
    );
  });

  it("answers the next appointment from today first, then this week", async () => {
    const none = await answerOf(emptyBrief(), "client.next-appointment", "client");
    assert.equal(
      none.status === "answered" && none.answer,
      "No upcoming appointments are scheduled.",
    );

    const week = emptyBrief();
    week.scheduled.thisWeek = [job("Quote visit", "2026-10-14")];
    const weekAns = await answerOf(week, "client.next-appointment", "client");
    assert.equal(
      weekAns.status === "answered" && weekAns.answer,
      "Next appointment: Quote visit on 2026-10-14.",
    );

    const today = emptyBrief();
    today.scheduled.today = [job("Roof clean", "2026-10-11")];
    today.scheduled.thisWeek = [job("Quote visit", "2026-10-14")];
    const todayAns = await answerOf(today, "client.next-appointment", "client");
    assert.equal(
      todayAns.status === "answered" && todayAns.answer,
      "Next appointment: Roof clean on 2026-10-11.",
    );
  });

  it("answers the workshop next job", async () => {
    const none = await answerOf(emptyBrief(), "workshop.next-job", "workshop");
    assert.equal(none.status === "answered" && none.answer, "No jobs are scheduled.");

    const b = emptyBrief();
    b.scheduled.today = [job("Rebuild pump")];
    const ans = await answerOf(b, "workshop.next-job", "workshop");
    assert.equal(ans.status === "answered" && ans.answer, "Next job: Rebuild pump.");
  });
});

describe("DailyBriefVoiceQueryProvider — boundaries", () => {
  it("reports equipment-status queries unavailable (not business data)", async () => {
    const ans = await answerOf(emptyBrief(), "workshop.status", "workshop");
    assert.equal(ans.status, "unavailable");
    if (ans.status === "unavailable") assert.match(ans.reason, /not backed by the daily brief/);
  });

  it("fails closed when the brief read throws (never fabricates an answer)", async () => {
    const provider = new DailyBriefVoiceQueryProvider(async () => {
      throw new Error("store down");
    });
    const ans = await provider.answer({ commandId: "client.unpaid-invoices", profile: "client" });
    assert.equal(ans.status, "failed");
    if (ans.status === "failed") assert.match(ans.reason, /could not be read/);
  });
});
