import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "build-logs-test-service-token-00000000000000";
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

describe("build log updatedAt", () => {
  it("stamps updatedAt on create and bumps it on update", async () => {
    const t = harness();
    const build = await t.mutation(api.builds.create, {
      serviceToken: SERVICE_TOKEN,
      name: "Timestamp test build",
      kind: "test",
    });
    const created = await t.mutation(api.buildLogs.create, {
      serviceToken: SERVICE_TOKEN,
      buildId: build._id,
      title: "First entry",
    });
    expect(created.updatedAt).toBe(created.createdAt);

    await new Promise((resolve) => setTimeout(resolve, 2));

    const updated = await t.mutation(api.buildLogs.update, {
      serviceToken: SERVICE_TOKEN,
      id: created._id,
      title: "Updated entry",
    });
    expect(updated?.updatedAt).toBeGreaterThan(created.updatedAt as number);
    expect(updated?.createdAt).toBe(created.createdAt);
  });

  it("reads a legacy row with no updatedAt (predates this field) without error", async () => {
    const t = harness();
    const id = await t.run((ctx) =>
      ctx.db.insert("buildLogs", {
        ownerId: OWNER_ID,
        buildId: "build-1",
        kind: "note",
        title: "Legacy entry",
        createdAt: Date.now(),
        // No updatedAt: simulates a row written before this field existed.
      }),
    );

    const fetched = await t.query(api.buildLogs.get, { serviceToken: SERVICE_TOKEN, id });
    expect(fetched?.updatedAt).toBeUndefined();

    const listed = await t.query(api.buildLogs.list, { serviceToken: SERVICE_TOKEN });
    expect(listed.find((entry) => entry._id === id)?.updatedAt).toBeUndefined();

    const updated = await t.mutation(api.buildLogs.update, {
      serviceToken: SERVICE_TOKEN,
      id,
      title: "Legacy entry, now touched",
    });
    expect(updated?.updatedAt).toEqual(expect.any(Number));
  });
});
