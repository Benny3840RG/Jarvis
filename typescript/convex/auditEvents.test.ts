import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "audit-events-test-service-token-0000000000";
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

describe("auditEvents.listActivityPage", () => {
  it("reads across every scope for one owner, not just one scopeKey", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert("auditEvents", {
        ownerId: OWNER_ID,
        scopeKey: "project-a",
        eventType: "tool.action.proposed",
        actor: "agent",
        payload: {},
        createdAt: 1_000,
      });
      await ctx.db.insert("auditEvents", {
        ownerId: OWNER_ID,
        scopeKey: "project-b",
        eventType: "tool.action.approved",
        actor: "user",
        payload: {},
        createdAt: 2_000,
      });
      await ctx.db.insert("auditEvents", {
        ownerId: OWNER_ID,
        scopeKey: "__global__",
        eventType: "memory.change_set.applied",
        actor: "tool",
        payload: {},
        createdAt: 3_000,
      });
    });

    const page = await t.query(api.auditEvents.listActivityPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page).toHaveLength(3);
    expect(page.isDone).toBe(true);
    expect(new Set(page.page.map((row) => row.scopeKey))).toEqual(
      new Set(["project-a", "project-b", "__global__"]),
    );
  });

  it("orders newest first and paginates with a bounded cursor, without duplicates", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i += 1) {
        await ctx.db.insert("auditEvents", {
          ownerId: OWNER_ID,
          scopeKey: `project-${i}`,
          eventType: "tool.action.proposed",
          actor: "agent",
          payload: {},
          createdAt: 1_000 + i,
        });
      }
    });

    const first = await t.query(api.auditEvents.listActivityPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    expect(first.page.map((row) => row.createdAt)).toEqual([1_002, 1_001]);

    const second = await t.query(api.auditEvents.listActivityPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);
    expect(second.page[0]?.createdAt).toBe(1_000);

    const rows = [...first.page, ...second.page];
    expect(new Set(rows.map((row) => row._id)).size).toBe(3);
  });

  it("orders events with an identical createdAt deterministically across repeated reads", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert("auditEvents", {
        ownerId: OWNER_ID,
        scopeKey: "project-a",
        eventType: "tool.action.proposed",
        actor: "agent",
        payload: { actionId: "first" },
        createdAt: 5_000,
      });
      await ctx.db.insert("auditEvents", {
        ownerId: OWNER_ID,
        scopeKey: "project-a",
        eventType: "tool.action.proposed",
        actor: "agent",
        payload: { actionId: "second" },
        createdAt: 5_000,
      });
    });

    const first = await t.query(api.auditEvents.listActivityPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const second = await t.query(api.auditEvents.listActivityPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(first.page.map((row) => row._id)).toEqual(second.page.map((row) => row._id));
  });

  it("never returns another owner's events", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert("auditEvents", {
        ownerId: OWNER_ID,
        scopeKey: "project-a",
        eventType: "tool.action.proposed",
        actor: "agent",
        payload: {},
        createdAt: 1_000,
      });
      await ctx.db.insert("auditEvents", {
        ownerId: "another-owner",
        scopeKey: "project-a",
        eventType: "tool.action.proposed",
        actor: "agent",
        payload: {},
        createdAt: 2_000,
      });
    });

    const page = await t.query(api.auditEvents.listActivityPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page).toHaveLength(1);
    expect(page.page[0]?.ownerId).toBe(OWNER_ID);
  });

  it.each([0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid activity page size %s",
    async (numItems) => {
      const t = harness();
      await expect(
        t.query(api.auditEvents.listActivityPage, {
          serviceToken: SERVICE_TOKEN,
          paginationOpts: { numItems, cursor: null },
        }),
      ).rejects.toThrow(/page size/i);
    },
  );
});
