import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "pagination-test-service-token-000000000000";
const OWNER_ID = "jarvis-cli";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bounded task and reminder pagination", () => {
  it("returns bounded owner-scoped task pages with cursor continuation and no duplicates", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (const title of ["task-one", "task-two", "task-three"]) {
        await ctx.db.insert("tasks", {
          ownerId: OWNER_ID,
          title,
          completed: false,
          category: "work",
          createdAt: Date.now(),
        });
      }
      await ctx.db.insert("tasks", {
        ownerId: "another-owner",
        title: "private-task",
        completed: false,
        category: "work",
        createdAt: Date.now(),
      });
    });

    const first = await t.query(api.tasks.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toEqual(expect.any(String));

    const second = await t.query(api.tasks.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);

    const rows = [...first.page, ...second.page];
    expect(new Set(rows.map((row) => row._id)).size).toBe(3);
    expect(rows.every((row) => row.ownerId === OWNER_ID)).toBe(true);
    expect(rows.map((row) => row.title)).not.toContain("private-task");
  });

  it("returns bounded owner-scoped reminder pages with cursor continuation and no duplicates", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (const title of ["reminder-one", "reminder-two", "reminder-three"]) {
        await ctx.db.insert("reminders", {
          ownerId: OWNER_ID,
          title,
          createdAt: Date.now(),
        });
      }
      await ctx.db.insert("reminders", {
        ownerId: "another-owner",
        title: "private-reminder",
        createdAt: Date.now(),
      });
    });

    const first = await t.query(api.reminders.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.reminders.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);

    const rows = [...first.page, ...second.page];
    expect(new Set(rows.map((row) => row._id)).size).toBe(3);
    expect(rows.every((row) => row.ownerId === OWNER_ID)).toBe(true);
    expect(rows.map((row) => row.title)).not.toContain("private-reminder");
  });

  it("returns bounded owner-and-project-scoped note pages with cursor continuation and no duplicates", async () => {
    const t = harness();
    const noteInput = (title: string, projectId: string, ownerId = OWNER_ID) => ({
      ownerId,
      projectId,
      title,
      body: "body",
      tags: [],
      domain: "home" as const,
      sensitivity: "internal" as const,
      retention: "standard" as const,
      idempotencyKey: `${title}-key`,
      actionFingerprint: `${title}-fingerprint`,
      sourceRequestId: `${title}-request`,
      correlationId: `${title}-correlation`,
      source: "test",
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await t.run(async (ctx) => {
      for (const title of ["note-one", "note-two", "note-three"]) {
        await ctx.db.insert("notes", noteInput(title, "console-project"));
      }
      await ctx.db.insert("notes", noteInput("other-project-note", "different-project"));
      await ctx.db.insert("notes", noteInput("private-note", "console-project", "another-owner"));
    });

    const first = await t.query(api.notes.listPage, {
      serviceToken: SERVICE_TOKEN,
      projectId: "console-project",
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toEqual(expect.any(String));

    const second = await t.query(api.notes.listPage, {
      serviceToken: SERVICE_TOKEN,
      projectId: "console-project",
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);

    const rows = [...first.page, ...second.page];
    expect(new Set(rows.map((row) => row._id)).size).toBe(3);
    expect(
      rows.every((row) => row.ownerId === OWNER_ID && row.projectId === "console-project"),
    ).toBe(true);
    expect(rows.map((row) => row.title)).not.toContain("other-project-note");
    expect(rows.map((row) => row.title)).not.toContain("private-note");
  });

  it.each([0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid task, reminder, and note page size %s",
    async (numItems) => {
      const t = harness();
      await expect(
        t.query(api.tasks.listPage, {
          serviceToken: SERVICE_TOKEN,
          paginationOpts: { numItems, cursor: null },
        }),
      ).rejects.toThrow(/page size/i);
      await expect(
        t.query(api.reminders.listPage, {
          serviceToken: SERVICE_TOKEN,
          paginationOpts: { numItems, cursor: null },
        }),
      ).rejects.toThrow(/page size/i);
      await expect(
        t.query(api.notes.listPage, {
          serviceToken: SERVICE_TOKEN,
          projectId: "console-project",
          paginationOpts: { numItems, cursor: null },
        }),
      ).rejects.toThrow(/page size/i);
    },
  );
});
