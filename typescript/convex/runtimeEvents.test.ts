import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "runtime-events-test-service-token-0000000000";
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

describe("runtimeEvents", () => {
  it("appends metadata and replays an identical event without duplication", async () => {
    const t = harness();
    const input = {
      serviceToken: SERVICE_TOKEN,
      eventId: "runtime-event-1",
      sequence: 1,
      eventType: "runtime.route.started",
      correlationId: "corr-1",
      route: "notes:create",
      metadata: { route: "notes:create" },
      occurredAt: 1_000,
    };

    const first = await t.mutation(api.runtimeEvents.append, input);
    const replay = await t.mutation(api.runtimeEvents.append, input);

    expect(first._id).toBe(replay._id);
    expect(first.ownerId).toBe(OWNER_ID);
    expect(first.metadata).toEqual({ route: "notes:create" });
  });

  it("rejects reuse of an event ID with different content", async () => {
    const t = harness();
    const input = {
      serviceToken: SERVICE_TOKEN,
      eventId: "runtime-event-collision",
      sequence: 1,
      eventType: "runtime.route.started",
      correlationId: "corr-1",
      metadata: {},
      occurredAt: 1_000,
    };
    await t.mutation(api.runtimeEvents.append, input);

    await expect(
      t.mutation(api.runtimeEvents.append, { ...input, eventType: "runtime.route.completed" }),
    ).rejects.toThrow(/collision/i);
  });

  it("pages only the authenticated owner's runtime events", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert("runtimeEvents", {
        ownerId: OWNER_ID,
        eventId: "mine",
        sequence: 1,
        eventType: "runtime.route.started",
        correlationId: "mine-corr",
        metadata: {},
        occurredAt: 1_000,
        createdAt: 1_000,
      });
      await ctx.db.insert("runtimeEvents", {
        ownerId: "another-owner",
        eventId: "theirs",
        sequence: 2,
        eventType: "runtime.route.started",
        correlationId: "other-corr",
        metadata: {},
        occurredAt: 2_000,
        createdAt: 2_000,
      });
    });

    const page = await t.query(api.runtimeEvents.listPage, {
      serviceToken: SERVICE_TOKEN,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page).toHaveLength(1);
    expect(page.page[0]?.eventId).toBe("mine");
  });
});
