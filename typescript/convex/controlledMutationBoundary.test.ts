import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "controlled-boundary-service-token-000000000";
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

async function seedControlledTask() {
  const t = harness();
  const id = await t.run(async (ctx) =>
    ctx.db.insert("tasks", {
      ownerId: OWNER_ID,
      projectId: "project-1",
      title: "Controlled task",
      completed: false,
      category: "workshop",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return { t, id };
}

async function seedControlledReminder() {
  const t = harness();
  const id = await t.run(async (ctx) =>
    ctx.db.insert("reminders", {
      ownerId: OWNER_ID,
      projectId: "project-1",
      title: "Controlled reminder",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return { t, id };
}

describe("controlled record mutation boundary", () => {
  it("rejects direct updates to project-scoped tasks", async () => {
    const { t, id } = await seedControlledTask();

    await expect(
      t.mutation(api.tasks.update, {
        serviceToken: SERVICE_TOKEN,
        id,
        title: "Bypassed update",
      }),
    ).rejects.toThrow(/controlled task execution/i);
  });

  it("rejects direct completion of project-scoped tasks", async () => {
    const { t, id } = await seedControlledTask();

    await expect(
      t.mutation(api.tasks.complete, { serviceToken: SERVICE_TOKEN, id }),
    ).rejects.toThrow(/controlled task execution/i);
  });

  it("rejects direct removal of project-scoped tasks", async () => {
    const { t, id } = await seedControlledTask();

    await expect(t.mutation(api.tasks.remove, { serviceToken: SERVICE_TOKEN, id })).rejects.toThrow(
      /controlled task execution/i,
    );
  });

  it("rejects direct updates to project-scoped reminders", async () => {
    const { t, id } = await seedControlledReminder();

    await expect(
      t.mutation(api.reminders.update, {
        serviceToken: SERVICE_TOKEN,
        id,
        title: "Bypassed update",
      }),
    ).rejects.toThrow(/controlled reminder execution/i);
  });

  it("rejects direct removal of project-scoped reminders", async () => {
    const { t, id } = await seedControlledReminder();

    await expect(
      t.mutation(api.reminders.remove, { serviceToken: SERVICE_TOKEN, id }),
    ).rejects.toThrow(/controlled reminder execution/i);
  });
});
