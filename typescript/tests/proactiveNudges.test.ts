import assert from "node:assert/strict";
import { test } from "node:test";

import type { Reminder, Task } from "../src/persistence/types.js";
import {
  CLASH_WINDOW_MS,
  STALE_TASK_AGE_MS,
  computeNudges,
  formatNudges,
} from "../src/runtime/proactiveNudges.js";

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    completed: false,
    category: "general",
    createdAt: NOW,
    ...overrides,
  };
}

function reminder(overrides: Partial<Reminder> & { id: string }): Reminder {
  return { title: overrides.id, createdAt: NOW, ...overrides };
}

test("no tasks or reminders gives no nudges and an all-clear line", () => {
  const nudges = computeNudges({ tasks: [], reminders: [], now: NOW });
  assert.deepEqual(nudges, []);
  assert.equal(formatNudges(nudges), "All clear. Nothing needs your attention.");
});

test("an overdue reminder is nudged with how long ago it was due", () => {
  const nudges = computeNudges({
    tasks: [],
    reminders: [reminder({ id: "r1", title: "Call the plumber", dueAt: NOW - 3 * HOUR })],
    now: NOW,
  });
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0]?.kind, "overdue-reminder");
  assert.deepEqual(nudges[0]?.refs, ["r1"]);
  assert.match(nudges[0]?.message ?? "", /Call the plumber.*3 hours ago/);
});

test("a reminder with words but no exact time is nudged because it will not go off", () => {
  const nudges = computeNudges({
    tasks: [],
    reminders: [reminder({ id: "r1", title: "Bins", dueRaw: "sometime next week" })],
    now: NOW,
  });
  assert.equal(nudges[0]?.kind, "untimed-reminder");
  assert.match(nudges[0]?.message ?? "", /Bins.*no exact time/);
});

test("a reminder with neither due text nor time is not nudged", () => {
  const nudges = computeNudges({ tasks: [], reminders: [reminder({ id: "r1" })], now: NOW });
  assert.deepEqual(nudges, []);
});

test("two upcoming reminders inside the clash window are nudged once as a clash", () => {
  const nudges = computeNudges({
    tasks: [],
    reminders: [
      reminder({ id: "a", title: "Dentist", dueAt: NOW + 2 * HOUR }),
      reminder({ id: "b", title: "School run", dueAt: NOW + 2 * HOUR + CLASH_WINDOW_MS - 1 }),
      reminder({ id: "c", title: "Gym", dueAt: NOW + 5 * HOUR }),
    ],
    now: NOW,
  });
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0]?.kind, "reminder-clash");
  assert.deepEqual(nudges[0]?.refs, ["a", "b"]);
  assert.match(nudges[0]?.message ?? "", /Dentist.*School run/);
});

test("reminders exactly the clash window apart do not clash", () => {
  const nudges = computeNudges({
    tasks: [],
    reminders: [
      reminder({ id: "a", dueAt: NOW + HOUR }),
      reminder({ id: "b", dueAt: NOW + HOUR + CLASH_WINDOW_MS }),
    ],
    now: NOW,
  });
  assert.deepEqual(nudges, []);
});

test("a pending task untouched for the stale age is nudged; completed and fresh ones are not", () => {
  const nudges = computeNudges({
    tasks: [
      task({ id: "old", title: "Fix gate", createdAt: NOW - 10 * DAY }),
      task({ id: "edited", createdAt: NOW - 30 * DAY, updatedAt: NOW - DAY }),
      task({ id: "done", completed: true, createdAt: NOW - 30 * DAY }),
      task({ id: "edge", createdAt: NOW - STALE_TASK_AGE_MS + 1 }),
    ],
    reminders: [],
    now: NOW,
  });
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0]?.kind, "stale-task");
  assert.deepEqual(nudges[0]?.refs, ["old"]);
  assert.match(nudges[0]?.message ?? "", /Fix gate.*10 days/);
});

test("nudges are ordered overdue, clash, untimed, stale and the formatted list is numbered", () => {
  const nudges = computeNudges({
    tasks: [task({ id: "t", title: "Old job", createdAt: NOW - 8 * DAY })],
    reminders: [
      reminder({ id: "u", title: "Vague", dueRaw: "soon" }),
      reminder({ id: "x", title: "Late", dueAt: NOW - DAY }),
      reminder({ id: "y", title: "One", dueAt: NOW + HOUR }),
      reminder({ id: "z", title: "Two", dueAt: NOW + HOUR }),
    ],
    now: NOW,
  });
  assert.deepEqual(
    nudges.map((n) => n.kind),
    ["overdue-reminder", "reminder-clash", "untimed-reminder", "stale-task"],
  );
  const text = formatNudges(nudges);
  assert.match(text, /^4 things need your attention:\n1\. /);
  assert.match(text, /\n4\. .*Old job/);
});

test("computeNudges never mutates its inputs", () => {
  const tasks = [task({ id: "t", createdAt: NOW - 8 * DAY })];
  const reminders = [
    reminder({ id: "b", dueAt: NOW + HOUR }),
    reminder({ id: "a", dueAt: NOW + HOUR }),
  ];
  const before = JSON.stringify({ tasks, reminders });
  computeNudges({ tasks, reminders, now: NOW });
  assert.equal(JSON.stringify({ tasks, reminders }), before);
});
