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

describe("bounded build-domain pagination", () => {
  it("returns bounded owner-scoped build pages with cursor continuation and no duplicates", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (const name of ["build-one", "build-two", "build-three"]) {
        await ctx.db.insert("builds", {
          ownerId: OWNER_ID,
          name,
          kind: "RC crawler",
          status: "planning",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      await ctx.db.insert("builds", {
        ownerId: "another-owner",
        name: "private-build",
        kind: "RC crawler",
        status: "planning",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const first = await t.query(api.builds.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toEqual(expect.any(String));

    const second = await t.query(api.builds.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);

    const rows = [...first.page, ...second.page];
    expect(new Set(rows.map((row) => row._id)).size).toBe(3);
    expect(rows.every((row) => row.ownerId === OWNER_ID)).toBe(true);
    expect(rows.map((row) => row.name)).not.toContain("private-build");
  });

  it("returns bounded owner-scoped build log pages with cursor continuation and no duplicates", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (const title of ["log-one", "log-two", "log-three"]) {
        await ctx.db.insert("buildLogs", {
          ownerId: OWNER_ID,
          buildId: "build-1",
          kind: "note",
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      await ctx.db.insert("buildLogs", {
        ownerId: "another-owner",
        buildId: "build-1",
        kind: "note",
        title: "private-log",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const first = await t.query(api.buildLogs.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.buildLogs.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);

    const rows = [...first.page, ...second.page];
    expect(new Set(rows.map((row) => row._id)).size).toBe(3);
    expect(rows.every((row) => row.ownerId === OWNER_ID)).toBe(true);
    expect(rows.map((row) => row.title)).not.toContain("private-log");
  });

  it("returns bounded owner-scoped upgrade pages with cursor continuation and no duplicates", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (const title of ["upgrade-one", "upgrade-two", "upgrade-three"]) {
        await ctx.db.insert("upgrades", {
          ownerId: OWNER_ID,
          buildId: "build-1",
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      await ctx.db.insert("upgrades", {
        ownerId: "another-owner",
        buildId: "build-1",
        title: "private-upgrade",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const first = await t.query(api.upgrades.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.upgrades.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);

    const rows = [...first.page, ...second.page];
    expect(new Set(rows.map((row) => row._id)).size).toBe(3);
    expect(rows.every((row) => row.ownerId === OWNER_ID)).toBe(true);
    expect(rows.map((row) => row.title)).not.toContain("private-upgrade");
  });

  it("returns bounded owner-scoped asset pages with cursor continuation and no duplicates", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (const name of ["asset-one", "asset-two", "asset-three"]) {
        await ctx.db.insert("assets", {
          ownerId: OWNER_ID,
          name,
          kind: "tool",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      await ctx.db.insert("assets", {
        ownerId: "another-owner",
        name: "private-asset",
        kind: "tool",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const first = await t.query(api.assets.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.assets.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);

    const rows = [...first.page, ...second.page];
    expect(new Set(rows.map((row) => row._id)).size).toBe(3);
    expect(rows.every((row) => row.ownerId === OWNER_ID)).toBe(true);
    expect(rows.map((row) => row.name)).not.toContain("private-asset");
  });

  it("returns bounded owner-scoped preference pages with cursor continuation and no duplicates", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (const key of ["pref-one", "pref-two", "pref-three"]) {
        await ctx.db.insert("preferences", {
          ownerId: OWNER_ID,
          key,
          value: "value",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      await ctx.db.insert("preferences", {
        ownerId: "another-owner",
        key: "private-pref",
        value: "value",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const first = await t.query(api.preferences.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.preferences.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);

    const rows = [...first.page, ...second.page];
    expect(new Set(rows.map((row) => row._id)).size).toBe(3);
    expect(rows.every((row) => row.ownerId === OWNER_ID)).toBe(true);
    expect(rows.map((row) => row.key)).not.toContain("private-pref");
  });

  it.each([0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid build, build log, upgrade, asset, and preference page size %s",
    async (numItems) => {
      const t = harness();
      await expect(
        t.query(api.builds.listPage, {
          serviceToken: SERVICE_TOKEN,
          paginationOpts: { numItems, cursor: null },
        }),
      ).rejects.toThrow(/page size/i);
      await expect(
        t.query(api.buildLogs.listPage, {
          serviceToken: SERVICE_TOKEN,
          paginationOpts: { numItems, cursor: null },
        }),
      ).rejects.toThrow(/page size/i);
      await expect(
        t.query(api.upgrades.listPage, {
          serviceToken: SERVICE_TOKEN,
          paginationOpts: { numItems, cursor: null },
        }),
      ).rejects.toThrow(/page size/i);
      await expect(
        t.query(api.assets.listPage, {
          serviceToken: SERVICE_TOKEN,
          paginationOpts: { numItems, cursor: null },
        }),
      ).rejects.toThrow(/page size/i);
      await expect(
        t.query(api.preferences.listPage, {
          serviceToken: SERVICE_TOKEN,
          paginationOpts: { numItems, cursor: null },
        }),
      ).rejects.toThrow(/page size/i);
    },
  );
});
