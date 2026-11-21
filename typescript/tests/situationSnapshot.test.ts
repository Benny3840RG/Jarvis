import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolAction, ToolActionService } from "../src/actions/toolActions.js";
import type { SystemStatus } from "../src/http/contracts.js";
import type { Reminder, Task } from "../src/persistence/types.js";
import type { Project } from "../src/projects/project.js";
import type { RuntimeReconciliationHealth } from "../src/reconciliation/runtimeReconciliationHost.js";
import {
  composeSituationSnapshot,
  situationSnapshotSchema,
  type SituationSources,
} from "../src/situation/situationSnapshot.js";

// Tuesday 17 November 2026, 11:42:05 in Melbourne (AEDT, UTC+11).
const NOW = Date.UTC(2026, 10, 17, 0, 42, 5);
const HOUR = 3_600_000;

function status(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    status: "ok",
    version: "0.1.0",
    sourceVersion: "test",
    provider: {
      name: "convex",
      reachability: "ok",
      authentication: "ok",
      schemaCompatibility: "compatible",
      deploymentVersion: null,
    },
    reconciliation: { state: "disabled", enabled: false },
    integrations: [],
    reasoning: { status: "not-configured" },
    voiceConversation: {
      status: "configured",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      reason: "Configured; no live provider probe has been performed.",
    },
    timezone: "Australia/Melbourne",
    layers: {},
    zState: "disabled",
    checkedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as unknown as SystemStatus;
}

const tasks: Task[] = [
  {
    id: "t1",
    title: "Quote the Smith fence",
    completed: false,
    category: "work",
    createdAt: 1,
    directCreateIdempotencyKey: "secret-idempotency-key",
  } as Task,
  { id: "t2", title: "Old job", completed: true, category: "work", createdAt: 1 },
];
const reminders: Reminder[] = [
  {
    id: "r1",
    title: "Call Dave",
    dueAt: NOW - HOUR,
    dueTimezone: "Australia/Melbourne",
    createdAt: 1,
  },
  {
    id: "r2",
    title: "Order bar oil",
    dueAt: NOW + 2 * HOUR,
    dueTimezone: "Australia/Melbourne",
    createdAt: 1,
  },
  {
    id: "r3",
    title: "Renew rego",
    dueAt: NOW + 20 * 24 * HOUR,
    dueTimezone: "Australia/Melbourne",
    createdAt: 1,
  },
];
const projects: Project[] = [
  {
    id: "p1",
    clientId: "c1",
    title: "Smith fence",
    status: "active",
    scheduledFor: "2026-11-17",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "p2",
    clientId: "c1",
    title: "Next week job",
    status: "active",
    scheduledFor: "2026-11-24",
    createdAt: 1,
    updatedAt: 1,
  },
];

function approvals(count: number): Pick<ToolActionService, "countProposed"> {
  return { countProposed: async () => ({ count, capped: false }) };
}

function sources(overrides: Partial<SituationSources> = {}): SituationSources {
  return {
    now: () => NOW,
    timezone: "Australia/Melbourne",
    status: { inspect: async () => status() },
    tasks: { listTasks: async () => tasks },
    reminders: { listReminders: async () => reminders },
    projects: { list: async () => projects },
    approvals: approvals(2),
    reconciliation: null,
    ...overrides,
  };
}

const boom = async (): Promise<never> => {
  throw new Error("source down");
};

describe("situation snapshot", () => {
  it("is deterministic from fixtures in the operator's local timezone", async () => {
    const first = await composeSituationSnapshot(sources());
    const second = await composeSituationSnapshot(sources());
    assert.deepEqual(first, second);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.generatedAt, "2026-11-17T00:42:05.000Z");
    assert.equal(first.timezone, "Australia/Melbourne");
    assert.deepEqual(first.fields.localTime, {
      status: "available",
      freshness: "live",
      source: "clock",
      observedAt: "2026-11-17T00:42:05.000Z",
      value: { localDate: "2026-11-17", localTime: "11:42", weekday: "Tuesday" },
    });
    assert.deepEqual(first.fields.openTasks.value, { count: 1, titles: ["Quote the Smith fence"] });
    assert.deepEqual(first.fields.reminders.value, {
      dueCount: 1,
      due: ["Call Dave"],
      upcomingCount: 1,
      upcoming: ["Order bar oil"],
    });
    assert.deepEqual(first.fields.jobsToday.value, { count: 1, titles: ["Smith fence"] });
    assert.deepEqual(first.fields.pendingApprovals.value, { count: 2, capped: false });
    assert.equal(first.fields.systemHealth.freshness, "live");
    assert.deepEqual(first.fields.systemHealth.value, {
      overall: "ok",
      persistence: "ok",
      provider: "convex",
      version: "0.1.0",
    });
    assert.deepEqual(first.fields.nolanBrain.value, {
      configured: true,
      provider: "anthropic",
      model: "claude-haiku-5-5",
      liveProbe: false,
    });
    assert.equal(situationSnapshotSchema.safeParse(first).success, true);
  });

  it("never invents calendar, presence or device data", async () => {
    const snapshot = await composeSituationSnapshot(sources());
    for (const key of ["calendar", "presence", "devices"] as const) {
      const field = snapshot.fields[key];
      assert.equal(field.status, "unknown", key);
      assert.equal(field.freshness, "unknown", key);
      assert.equal(field.observedAt, null, key);
      assert.equal("value" in field, false, key);
      assert.ok(field.reason, key);
    }
    assert.match(snapshot.fields.presence.reason ?? "", /never inferred/);
  });

  it("shows missing and failed sources as unavailable, never healthy or current", async () => {
    const missing = await composeSituationSnapshot(
      sources({ status: null, tasks: null, reminders: null, projects: null, approvals: null }),
    );
    const failed = await composeSituationSnapshot(
      sources({
        status: { inspect: boom },
        tasks: { listTasks: boom },
        reminders: { listReminders: boom },
        projects: { list: boom },
        approvals: { countProposed: boom },
      }),
    );
    for (const snapshot of [missing, failed]) {
      for (const key of [
        "systemHealth",
        "nolanBrain",
        "openTasks",
        "reminders",
        "jobsToday",
        "pendingApprovals",
      ] as const) {
        const field = snapshot.fields[key];
        assert.equal(field.status, "unavailable", key);
        assert.equal(field.freshness, "unknown", key);
        assert.equal("value" in field, false, `${key} carries no value`);
      }
      assert.equal(situationSnapshotSchema.safeParse(snapshot).success, true);
    }
  });

  it("an invalid timezone makes time-dependent fields unknown instead of guessing", async () => {
    const snapshot = await composeSituationSnapshot(sources({ timezone: "Not/AZone" }));
    assert.equal(snapshot.timezone, null);
    for (const key of ["localTime", "reminders", "jobsToday"] as const) {
      assert.equal(snapshot.fields[key].status, "unknown", key);
    }
  });

  it("reports cached reconciliation as cached or stale, never live", async () => {
    const health =
      (overrides: Partial<RuntimeReconciliationHealth>): (() => RuntimeReconciliationHealth) =>
      () =>
        ({
          state: "running",
          enabled: true,
          freshnessMs: 10 * 60_000,
          ...overrides,
        }) as RuntimeReconciliationHealth;
    const fresh = await composeSituationSnapshot(
      sources({
        reconciliation: health({
          lastSuccessfulCycleAt: new Date(NOW - 2 * 60_000).toISOString(),
          lastCycleOutcome: "success",
        }),
      }),
    );
    assert.equal(fresh.fields.reconciliation.status, "available");
    assert.equal(fresh.fields.reconciliation.freshness, "cached");
    assert.equal(fresh.fields.reconciliation.observedAt, new Date(NOW - 2 * 60_000).toISOString());

    const old = await composeSituationSnapshot(
      sources({
        reconciliation: health({
          lastSuccessfulCycleAt: new Date(NOW - 3 * HOUR).toISOString(),
          lastCycleOutcome: "failed",
        }),
      }),
    );
    assert.equal(old.fields.reconciliation.freshness, "stale");

    const never = await composeSituationSnapshot(sources({ reconciliation: health({}) }));
    assert.equal(never.fields.reconciliation.status, "unknown");

    const disabled = await composeSituationSnapshot(
      sources({
        reconciliation: () =>
          ({ state: "disabled", enabled: false }) as RuntimeReconciliationHealth,
      }),
    );
    assert.equal(disabled.fields.reconciliation.status, "unknown");
    assert.match(disabled.fields.reconciliation.reason ?? "", /disabled/);
  });

  it("carries no secrets or private record fields", async () => {
    const snapshot = await composeSituationSnapshot(
      sources({
        reconciliation: () =>
          ({
            state: "running",
            enabled: true,
            workerId: "worker-internal-id",
            lastErrorCode: "INTERNAL",
            lastSuccessfulCycleAt: new Date(NOW).toISOString(),
          }) as RuntimeReconciliationHealth,
      }),
    );
    const text = JSON.stringify(snapshot);
    for (const forbidden of [
      "secret-idempotency-key",
      "directCreateIdempotencyKey",
      "worker-internal-id",
      "serviceToken",
      "approvalToken",
    ]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });

  it("is read-only: never stages, approves, rejects or executes a ToolAction", async () => {
    const calls: string[] = [];
    const refuse = (name: string) => async (): Promise<ToolAction> => {
      calls.push(name);
      throw new Error(`${name} must not be called`);
    };
    const service: ToolActionService = {
      stage: refuse("stage"),
      get: async () => null,
      list: async () => [],
      approve: refuse("approve"),
      reject: refuse("reject"),
      countProposed: async () => ({ count: 0, capped: false }),
    };
    const snapshot = await composeSituationSnapshot(sources({ approvals: service }));
    assert.deepEqual(calls, []);
    assert.deepEqual(snapshot.fields.pendingApprovals.value, { count: 0, capped: false });
  });

  it("the schema rejects a field that claims a value it cannot have", () => {
    const valid = {
      status: "unknown",
      freshness: "unknown",
      source: "none",
      observedAt: null,
      reason: "x",
    };
    const check = (field: unknown) =>
      situationSnapshotSchema.shape.fields.shape.calendar.safeParse(field).success;
    assert.equal(check(valid), true);
    assert.equal(check({ ...valid, value: {} }), false, "unknown with a value");
    assert.equal(check({ ...valid, status: "available" }), false, "available without a value");
    assert.equal(check({ ...valid, freshness: "live" }), false, "unknown that claims to be live");
  });
});
