import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "task-reopen-service-token-0000000000000";

function context(key: string) {
  return {
    idempotencyKey: key,
    actionFingerprint: `fingerprint:${key}`,
    sourceRequestId: `request:${key}`,
    correlationId: `correlation:${key}`,
    source: "voice-direct",
  };
}

async function seedCompleted(projectId = "nolan-voice") {
  const t = convexTest(schema, modules);
  const created = await t.mutation(api.tasks.createControlled, {
    serviceToken: SERVICE_TOKEN,
    projectId,
    title: "Milk",
    category: "personal",
    ...context("create-1"),
  });
  await t.mutation(api.tasks.completeControlled, {
    serviceToken: SERVICE_TOKEN,
    projectId,
    id: created.id,
    ...context("complete-1"),
  });
  return { t, created };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("voice undo reopenControlled", () => {
  it("puts a completed task back to open and bumps its revision", async () => {
    const { t, created } = await seedCompleted();
    const reopened = await t.mutation(api.tasks.reopenControlled, {
      serviceToken: SERVICE_TOKEN,
      projectId: "nolan-voice",
      id: created.id,
    });
    expect(reopened).toMatchObject({ id: created.id, completed: false });
    expect(reopened?.revision).toBe(created.revision + 2);
    // The task can be completed again under a new key.
    const again = await t.mutation(api.tasks.completeControlled, {
      serviceToken: SERVICE_TOKEN,
      projectId: "nolan-voice",
      id: created.id,
      ...context("complete-2"),
    });
    expect(again).toMatchObject({ completed: true });
  });

  it("refuses a task in another project", async () => {
    const { t, created } = await seedCompleted();
    const other = await t.mutation(api.tasks.reopenControlled, {
      serviceToken: SERVICE_TOKEN,
      projectId: "someone-else",
      id: created.id,
    });
    expect(other).toBeNull();
    const stored = await t.query(api.tasks.getControlled, {
      serviceToken: SERVICE_TOKEN,
      projectId: "nolan-voice",
      id: created.id,
    });
    expect(stored).toMatchObject({ completed: true });
  });
});
