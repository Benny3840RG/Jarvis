import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as paginationModule from "../pagination.js";
import {
  buildConsolePageSummary,
  formatPartialCount,
  normaliseConsolePageRequest,
  taskProgressLabel,
} from "../pagination.js";
import { propSchema } from "../resources/product-search-result/types.js";

function consoleProps(tasks: unknown[] = [], reminders: unknown[] = [], notes: unknown[] = []) {
  return {
    title: "JARVIS SYSTEM // CONSOLE 01",
    phase: "TEST",
    deployment: "test",
    environment: "test",
    status: "operational",
    mission: "test",
    progress: 0,
    lastUpdated: 1,
    tasks,
    reminders,
    notes,
    systems: [],
    activity: [],
    counts: {
      active: tasks.length,
      completed: 0,
      reminders: reminders.length,
      notes: notes.length,
      tasksPartial: false,
      remindersPartial: false,
      notesPartial: false,
    },
    pagination: {
      tasks: {
        isDone: true,
        continueCursor: "",
        returnedCount: tasks.length,
        requestedPageSize: 100,
      },
      reminders: {
        isDone: true,
        continueCursor: "",
        returnedCount: reminders.length,
        requestedPageSize: 100,
      },
      notes: {
        isDone: true,
        continueCursor: "",
        returnedCount: notes.length,
        requestedPageSize: 100,
      },
    },
  };
}

test("normalises the default and maximum bounded page sizes", () => {
  assert.deepEqual(normaliseConsolePageRequest({}), {
    pageSize: 50,
    taskCursor: null,
    reminderCursor: null,
    noteCursor: null,
  });
  assert.equal(normaliseConsolePageRequest({ pageSize: 100 }).pageSize, 100);

  for (const pageSize of [0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => normaliseConsolePageRequest({ pageSize }), /page size/i);
  }
});

test("summarises visible rows without presenting partial pages as dataset totals", () => {
  const summary = buildConsolePageSummary(
    {
      page: [
        { completed: false },
        { completed: true },
      ],
      isDone: false,
      continueCursor: "next-task-page",
    },
    {
      page: [{ title: "Call supplier" }],
      isDone: false,
      continueCursor: "next-reminder-page",
    },
    {
      page: [{ title: "Vendor contract" }],
      isDone: false,
      continueCursor: "next-note-page",
    },
    50,
  );

  assert.deepEqual(summary.counts, {
    active: 1,
    completed: 1,
    reminders: 1,
    notes: 1,
    tasksPartial: true,
    remindersPartial: true,
    notesPartial: true,
  });
  assert.equal(summary.progress, 50);
  assert.deepEqual(summary.pagination.tasks, {
    isDone: false,
    continueCursor: "next-task-page",
    returnedCount: 2,
    requestedPageSize: 50,
  });
  assert.deepEqual(summary.pagination.reminders, {
    isDone: false,
    continueCursor: "next-reminder-page",
    returnedCount: 1,
    requestedPageSize: 50,
  });
  assert.deepEqual(summary.pagination.notes, {
    isDone: false,
    continueCursor: "next-note-page",
    returnedCount: 1,
    requestedPageSize: 50,
  });
  assert.equal(formatPartialCount(50, true), "50+");
  assert.equal(formatPartialCount(7, false), "7");
  assert.equal(taskProgressLabel(true), "VISIBLE-PAGE PROGRESS");
  assert.equal(taskProgressLabel(false), "LIVE STATE");
});

test("terminal continuation pages remain partial for tasks and reminders", () => {
  const summary = Reflect.apply(buildConsolePageSummary, undefined, [
    {
      page: [{ completed: true }],
      isDone: true,
      continueCursor: "terminal-task-cursor",
    },
    {
      page: [{ title: "Last reminder" }],
      isDone: true,
      continueCursor: "terminal-reminder-cursor",
    },
    {
      page: [{ title: "Last note" }],
      isDone: true,
      continueCursor: "terminal-note-cursor",
    },
    50,
    {
      taskCursor: "input-task-cursor",
      reminderCursor: "input-reminder-cursor",
      noteCursor: "input-note-cursor",
    },
  ]) as {
    counts: { tasksPartial: boolean; remindersPartial: boolean; notesPartial: boolean };
  };

  assert.equal(summary.counts.tasksPartial, true);
  assert.equal(summary.counts.remindersPartial, true);
  assert.equal(summary.counts.notesPartial, true);
  assert.equal(taskProgressLabel(summary.counts.tasksPartial), "VISIBLE-PAGE PROGRESS");
});

test("bridge failures return fixed public activity without sentinel cursor or token text", () => {
  const sentinelCursor = "cursor-DO-NOT-RETURN-781";
  const sentinelToken = "token-DO-NOT-RETURN-493";
  const bridgeFailureActivity = (
    paginationModule as unknown as {
      bridgeFailureActivity?: (activity: string[], error?: unknown) => string[];
    }
  ).bridgeFailureActivity;

  assert.equal(typeof bridgeFailureActivity, "function");
  if (typeof bridgeFailureActivity !== "function") return;

  const returned = bridgeFailureActivity(
    ["Console snapshot requested"],
    new Error(`Convex rejected ${sentinelCursor} using ${sentinelToken}`),
  );
  const prose = returned.join("\n");
  assert.doesNotMatch(prose, new RegExp(sentinelCursor));
  assert.doesNotMatch(prose, new RegExp(sentinelToken));
  assert.match(prose, /temporarily unavailable/i);
});

test("Console error handling never copies raw exception messages into activity", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /error\.message/);
});

test("System Core repeats the same visible partial markers as telemetry", async () => {
  const source = await readFile(
    new URL("../resources/product-search-result/widget.tsx", import.meta.url),
    "utf8",
  );
  const activeMarkers = source.match(
    /formatPartialCount\(snapshot\.counts\.active, snapshot\.counts\.tasksPartial\)/g,
  );
  const reminderMarkers = source.match(
    /formatPartialCount\(snapshot\.counts\.reminders, snapshot\.counts\.remindersPartial\)/g,
  );
  assert.ok((activeMarkers?.length ?? 0) >= 2);
  assert.ok((reminderMarkers?.length ?? 0) >= 2);
});

test("Console output schemas reject more than 100 task, reminder, or note rows", async () => {
  const tasks = Array.from({ length: 101 }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    completed: false,
    category: "work",
    createdAt: index,
  }));
  const reminders = Array.from({ length: 101 }, (_, index) => ({
    id: `reminder-${index}`,
    title: `Reminder ${index}`,
    createdAt: index,
  }));
  const notes = Array.from({ length: 101 }, (_, index) => ({
    id: `note-${index}`,
    title: `Note ${index}`,
    body: `Body ${index}`,
    tags: [],
    domain: "home" as const,
    sensitivity: "internal" as const,
    createdAt: index,
  }));

  assert.equal(propSchema.safeParse(consoleProps(tasks, [], [])).success, false);
  assert.equal(propSchema.safeParse(consoleProps([], reminders, [])).success, false);
  assert.equal(propSchema.safeParse(consoleProps([], [], notes)).success, false);

  const serverSource = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(serverSource, /tasks: z\.array\(taskSchema\)\.max\(100\)/);
  assert.match(serverSource, /reminders: z\.array\(reminderSchema\)\.max\(100\)/);
  assert.match(serverSource, /notes: z\.array\(noteSchema\)\.max\(100\)/);
});

test("Console page summaries reject rows beyond the requested size", () => {
  assert.throws(
    () =>
      buildConsolePageSummary(
        {
          page: [
            { completed: false },
            { completed: false },
            { completed: false },
          ],
          isDone: true,
          continueCursor: "",
        },
        {
          page: [],
          isDone: true,
          continueCursor: "",
        },
        {
          page: [],
          isDone: true,
          continueCursor: "",
        },
        2,
      ),
    /page.*requested|returned.*rows/i,
  );
});

test("Console output schema enforces returned-count metadata invariants", () => {
  const props = consoleProps(
    [{ id: "task-1", title: "Task", completed: false, category: "work", createdAt: 1 }],
    [],
    [],
  );
  props.pagination.tasks.returnedCount = 0;
  assert.equal(propSchema.safeParse(props).success, false);
});

test("Console 01 source calls only bounded task, reminder, and note page queries", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /anyApi\.tasks\.listPage/);
  assert.match(source, /anyApi\.reminders\.listPage/);
  assert.match(source, /anyApi\.notes\.listPage/);
  assert.doesNotMatch(source, /anyApi\.tasks\.list[,)]/);
  assert.doesNotMatch(source, /anyApi\.reminders\.list[,)]/);
  assert.doesNotMatch(source, /anyApi\.notes\.list[,)]/);
});
