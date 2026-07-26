import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "build-relationship-service-token-000000000";
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

async function seedBuilds() {
  const t = harness();
  const ownedId = await t.run(async (ctx) =>
    ctx.db.insert("builds", {
      ownerId: OWNER_ID,
      name: "Owned build",
      kind: "machine",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const foreignId = await t.run(async (ctx) =>
    ctx.db.insert("builds", {
      ownerId: "another-owner",
      name: "Foreign build",
      kind: "machine",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return { t, ownedId, foreignId };
}

describe("build child ownership", () => {
  it("rejects build logs for missing or foreign builds", async () => {
    const { t, foreignId } = await seedBuilds();

    await expect(
      t.mutation(api.buildLogs.create, {
        serviceToken: SERVICE_TOKEN,
        buildId: "missing-build",
        title: "Orphan log",
      }),
    ).rejects.toThrow(/build does not exist/i);

    await expect(
      t.mutation(api.buildLogs.create, {
        serviceToken: SERVICE_TOKEN,
        buildId: foreignId,
        title: "Foreign log",
      }),
    ).rejects.toThrow(/build does not exist/i);
  });

  it("rejects upgrades for missing or foreign builds", async () => {
    const { t, foreignId } = await seedBuilds();

    await expect(
      t.mutation(api.upgrades.create, {
        serviceToken: SERVICE_TOKEN,
        buildId: "missing-build",
        title: "Orphan upgrade",
      }),
    ).rejects.toThrow(/build does not exist/i);

    await expect(
      t.mutation(api.upgrades.create, {
        serviceToken: SERVICE_TOKEN,
        buildId: foreignId,
        title: "Foreign upgrade",
      }),
    ).rejects.toThrow(/build does not exist/i);
  });

  it("accepts owned build relationships", async () => {
    const { t, ownedId } = await seedBuilds();

    const log = await t.mutation(api.buildLogs.create, {
      serviceToken: SERVICE_TOKEN,
      buildId: ownedId,
      title: "Owned log",
    });
    const upgrade = await t.mutation(api.upgrades.create, {
      serviceToken: SERVICE_TOKEN,
      buildId: ownedId,
      title: "Owned upgrade",
    });

    expect(log.buildId).toBe(ownedId);
    expect(upgrade.buildId).toBe(ownedId);
  });
});
