import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BRIEF_HIGHLIGHT_LIMIT,
  BRIEF_UPCOMING_WINDOW_MS,
  composeDailyBrief,
} from "../src/briefs/brief.js";
import type { Reminder, Task } from "../src/persistence/types.js";
import type { Project } from "../src/projects/project.js";
import type { Quote, QuoteStatus } from "../src/quotes/quote.js";

const NOW = Date.UTC(2026, 6, 21, 8, 0, 0);

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

function baseInputs() {
  return {
    now: NOW,
    timezone: "Australia/Melbourne",
    tasks: [] as Task[],
    reminders: [] as Reminder[],
    projects: [] as Project[],
    quotes: [] as Quote[],
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
      "1 open task, 1 reminder due, 1 active project, 1 quote awaiting response.",
    );
    assert.equal(brief.generatedAt, new Date(NOW).toISOString());
    assert.equal(brief.timezone, "Australia/Melbourne");
  });

  it("pluralises the headline and stays calm when everything is empty", () => {
    const brief = composeDailyBrief(baseInputs());
    assert.equal(
      brief.headline,
      "0 open tasks, 0 reminders due, 0 active projects, 0 quotes awaiting response.",
    );
    assert.deepEqual(brief.tasks.open, []);
    assert.equal(brief.quotes.pipelineTotal, 0);
  });
});
