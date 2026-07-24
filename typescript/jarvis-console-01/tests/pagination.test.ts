import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildConsolePageSummary,
  formatPartialCount,
  normaliseConsolePageRequest,
  taskProgressLabel,
} from "../pagination.js";

test("normalises the default and maximum bounded page sizes", () => {
  assert.deepEqual(normaliseConsolePageRequest({}), {
    pageSize: 50,
    taskCursor: null,
    reminderCursor: null,
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
    50,
  );

  assert.deepEqual(summary.counts, {
    active: 1,
    completed: 1,
    reminders: 1,
    tasksPartial: true,
    remindersPartial: true,
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
  assert.equal(formatPartialCount(50, true), "50+");
  assert.equal(formatPartialCount(7, false), "7");
  assert.equal(taskProgressLabel(true), "VISIBLE-PAGE PROGRESS");
  assert.equal(taskProgressLabel(false), "LIVE STATE");
});

test("Console 01 source calls only bounded task and reminder page queries", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /anyApi\.tasks\.listPage/);
  assert.match(source, /anyApi\.reminders\.listPage/);
  assert.doesNotMatch(source, /anyApi\.tasks\.list[,)]/);
  assert.doesNotMatch(source, /anyApi\.reminders\.list[,)]/);
});
