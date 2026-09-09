import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "assistant-state-test-service-token-00000000";

beforeEach(() => vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN));
afterEach(() => vi.unstubAllEnvs());

describe("assistant state server validation", () => {
  for (const existing of [false, true]) {
    it(`rejects invalid direct upserts with existing state ${String(existing)}`, async () => {
      const t = convexTest(schema, modules);
      if (existing) {
        await t.mutation(api.assistantState.upsert, {
          serviceToken: SERVICE_TOKEN,
          state: { lastIntent: "preserved", custom: { values: [0, null, -1] } },
        });
      }
      const before = await t.query(api.assistantState.get, { serviceToken: SERVICE_TOKEN });
      for (const state of [
        null,
        [],
        "text",
        42,
        true,
        { score: NaN },
        { scores: [Infinity, -Infinity] },
      ]) {
        await expect(
          t.mutation(api.assistantState.upsert, {
            serviceToken: SERVICE_TOKEN,
            state,
          }),
        ).rejects.toThrow(/Assistant state/);
        expect(await t.query(api.assistantState.get, { serviceToken: SERVICE_TOKEN })).toEqual(
          before,
        );
      }
    });
  }

  it("updates the same owner row with valid nested state and an empty object", async () => {
    const t = convexTest(schema, modules);
    const state = { lastIntent: "help", custom: { values: [0, null, -1] } };
    const id = await t.mutation(api.assistantState.upsert, { serviceToken: SERVICE_TOKEN, state });
    expect(await t.query(api.assistantState.get, { serviceToken: SERVICE_TOKEN })).toMatchObject({
      _id: id,
      ownerId: "jarvis-cli",
      state,
    });
    expect(
      await t.mutation(api.assistantState.upsert, { serviceToken: SERVICE_TOKEN, state: {} }),
    ).toBe(id);
    expect((await t.query(api.assistantState.get, { serviceToken: SERVICE_TOKEN }))?.state).toEqual(
      {},
    );
  });

  it("authenticates before validating state", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.assistantState.upsert, { serviceToken: "invalid", state: null }),
    ).rejects.toThrow(/Unauthorized/);
    expect(await t.query(api.assistantState.get, { serviceToken: SERVICE_TOKEN })).toBeNull();
  });

  it("rejects non-finite restore state without creating any records", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.assistantState.restoreEmpty, {
        serviceToken: SERVICE_TOKEN,
        state: { scores: [Infinity] },
        tasks: [{ sourceId: "task-1", title: "Task", category: "personal", completed: false }],
        reminders: [],
      }),
    ).rejects.toThrow(/Assistant state/);
    expect(await t.query(api.assistantState.snapshot, { serviceToken: SERVICE_TOKEN })).toEqual({
      state: {},
      tasks: [],
      reminders: [],
    });
  });
});
