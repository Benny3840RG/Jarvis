import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolAction } from "../src/actions/toolActions.js";
import { ToolExecutionService } from "../src/actions/toolExecution.js";
import { createToolExecutionDefinitions } from "../src/actions/toolExecutionFactory.js";
import { reminderRescheduleEnabledFromEnv } from "../src/actions/taskReminderTools.js";
import type { CreateNoteInput, NoteRecord, NoteStore } from "../src/notes/note.js";
import type {
  CancelControlledReminderInput,
  ControlledReminderRecord,
  ControlledReminderStore,
  CreateControlledReminderInput,
  RescheduleControlledReminderInput,
} from "../src/reminders/controlledReminder.js";
import type {
  CompleteControlledTaskInput,
  ControlledTaskRecord,
  ControlledTaskStore,
  CreateControlledTaskInput,
} from "../src/tasks/controlledTask.js";

class StubNoteStore implements NoteStore {
  async create(input: CreateNoteInput): Promise<NoteRecord> {
    return {
      id: "note-1",
      projectId: input.projectId,
      title: input.title,
      body: input.body,
      tags: input.tags,
      domain: input.domain,
      sensitivity: input.sensitivity,
      retention: input.retention,
      sourceRequestId: input.sourceRequestId,
      correlationId: input.correlationId,
      source: input.source,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  async get(): Promise<NoteRecord | null> {
    return null;
  }

  async list(): Promise<NoteRecord[]> {
    return [];
  }

  async remove(): Promise<NoteRecord | null> {
    return null;
  }
}

class RecordingTaskStore implements ControlledTaskStore {
  readonly creates: CreateControlledTaskInput[] = [];
  readonly completions: CompleteControlledTaskInput[] = [];
  completeResult: ControlledTaskRecord | null = null;

  async create(input: CreateControlledTaskInput): Promise<ControlledTaskRecord> {
    this.creates.push(input);
    return {
      id: "task-1",
      projectId: input.projectId,
      title: input.title,
      category: input.category,
      completed: false,
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    };
  }

  async complete(input: CompleteControlledTaskInput): Promise<ControlledTaskRecord | null> {
    this.completions.push(input);
    return this.completeResult;
  }

  async get(): Promise<ControlledTaskRecord | null> {
    return null;
  }

  async cleanup(): Promise<boolean> {
    return false;
  }
}

class RecordingReminderStore implements ControlledReminderStore {
  readonly creates: CreateControlledReminderInput[] = [];
  readonly cancellations: CancelControlledReminderInput[] = [];
  cancelResult: ControlledReminderRecord | null = null;

  async create(input: CreateControlledReminderInput): Promise<ControlledReminderRecord> {
    this.creates.push(input);
    return {
      id: "reminder-1",
      projectId: input.projectId,
      title: input.title,
      ...(input.dueRaw === undefined ? {} : { dueRaw: input.dueRaw }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.dueTimezone === undefined ? {} : { dueTimezone: input.dueTimezone }),
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    };
  }

  async cancel(input: CancelControlledReminderInput): Promise<ControlledReminderRecord | null> {
    this.cancellations.push(input);
    return this.cancelResult;
  }

  async get(): Promise<ControlledReminderRecord | null> {
    return null;
  }

  async cleanup(): Promise<boolean> {
    return false;
  }
}

function approvedAction(
  tool: string,
  operation: string,
  argumentsValue: Record<string, unknown>,
): ToolAction {
  return {
    actionId: `action-${tool}-${operation}`,
    requestId: `request-${tool}-${operation}`,
    projectId: "project-1",
    baseRevision: 1,
    state: "approved",
    tool,
    operation,
    arguments: argumentsValue,
    rationale: "Commission a reviewed internal mutation.",
    requiredAuthority: "T1",
    destructive: operation === "cancel",
    idempotencyKey: `proposal-${tool}-${operation}`,
    proposedBy: "agent",
    approvedBy: "user",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    approvedAt: "2026-07-24T00:00:00.000Z",
  };
}

function service(taskStore: RecordingTaskStore, reminderStore: RecordingReminderStore) {
  return new ToolExecutionService(
    createToolExecutionDefinitions(new StubNoteStore(), taskStore, reminderStore),
  );
}

describe("task and reminder tool allowlist", () => {
  it("registers exactly the reviewed internal and education operations", () => {
    const definitions = createToolExecutionDefinitions(
      new StubNoteStore(),
      new RecordingTaskStore(),
      new RecordingReminderStore(),
    );
    assert.deepEqual(
      definitions.map(({ tool, operation }) => `${tool}:${operation}`),
      [
        "notes:create",
        "security:explain",
        "security:interpret",
        "tasks:create",
        "tasks:complete",
        "reminders:create",
        "reminders:cancel",
      ],
    );
  });

  it("creates a task with immutable execution context", async () => {
    const tasks = new RecordingTaskStore();
    const reminders = new RecordingReminderStore();
    const result = await service(tasks, reminders).execute({
      action: approvedAction("tasks", "create", {
        title: "Service compressor",
        category: "workshop",
      }),
      authority: "T1",
      idempotencyKey: "execute-task-create",
      correlationId: "correlation-task-create",
      source: "tool-action-http",
    });

    assert.equal(result.status, "succeeded");
    assert.equal(tasks.creates.length, 1);
    assert.deepEqual(tasks.creates[0], {
      projectId: "project-1",
      title: "Service compressor",
      category: "workshop",
      idempotencyKey: "execute-task-create",
      actionFingerprint: result.actionFingerprint,
      sourceRequestId: "request-tasks-create",
      correlationId: "correlation-task-create",
      source: "tool-action-http",
    });
  });

  it("completes a task and fails closed when the target is stale or inaccessible", async () => {
    const tasks = new RecordingTaskStore();
    const reminders = new RecordingReminderStore();
    tasks.completeResult = {
      id: "task-1",
      projectId: "project-1",
      title: "Service compressor",
      category: "workshop",
      completed: true,
      createdAt: 1,
      updatedAt: 2,
      revision: 2,
      completedAt: 2,
    };

    const succeeded = await service(tasks, reminders).execute({
      action: approvedAction("tasks", "complete", { taskId: "task-1" }),
      authority: "T1",
      idempotencyKey: "execute-task-complete",
    });
    assert.equal(succeeded.status, "succeeded");
    assert.equal(tasks.completions[0]?.taskId, "task-1");

    tasks.completeResult = null;
    const failed = await service(tasks, reminders).execute({
      action: {
        ...approvedAction("tasks", "complete", { taskId: "missing-task" }),
        actionId: "action-task-missing",
        requestId: "request-task-missing",
      },
      authority: "T1",
      idempotencyKey: "execute-task-missing",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "failed");
  });

  it("creates and cancels a reminder with normalized due metadata", async () => {
    const tasks = new RecordingTaskStore();
    const reminders = new RecordingReminderStore();
    const created = await service(tasks, reminders).execute({
      action: approvedAction("reminders", "create", {
        title: "Check compressor pressure",
        dueRaw: "tomorrow 7:00 am",
        dueAt: 1_785_000_000_000,
        dueTimezone: "Australia/Melbourne",
      }),
      authority: "T1",
      idempotencyKey: "execute-reminder-create",
    });

    assert.equal(created.status, "succeeded");
    assert.deepEqual(reminders.creates[0], {
      projectId: "project-1",
      title: "Check compressor pressure",
      dueRaw: "tomorrow 7:00 am",
      dueAt: 1_785_000_000_000,
      dueTimezone: "Australia/Melbourne",
      idempotencyKey: "execute-reminder-create",
      actionFingerprint: created.actionFingerprint,
      sourceRequestId: "request-reminders-create",
      correlationId: "request-reminders-create",
      source: "tool-execution-service",
    });

    reminders.cancelResult = {
      id: "reminder-1",
      projectId: "project-1",
      title: "Check compressor pressure",
      createdAt: 1,
      updatedAt: 2,
      revision: 2,
      cancelledAt: 2,
    };
    const cancelled = await service(tasks, reminders).execute({
      action: approvedAction("reminders", "cancel", { reminderId: "reminder-1" }),
      authority: "T1",
      idempotencyKey: "execute-reminder-cancel",
    });
    assert.equal(cancelled.status, "succeeded");
    assert.equal(reminders.cancellations[0]?.reminderId, "reminder-1");
  });

  it("blocks malformed due combinations before mutating the reminder store", async () => {
    const tasks = new RecordingTaskStore();
    const reminders = new RecordingReminderStore();
    const result = await service(tasks, reminders).execute({
      action: approvedAction("reminders", "create", {
        title: "Broken reminder",
        dueAt: 1_785_000_000_000,
      }),
      authority: "T1",
      idempotencyKey: "invalid-reminder-due",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "invalid-arguments");
    assert.equal(reminders.creates.length, 0);
  });

  it("blocks insufficient authority and dry-run mutations", async () => {
    const tasks = new RecordingTaskStore();
    const reminders = new RecordingReminderStore();
    const unauthorized = await service(tasks, reminders).execute({
      action: approvedAction("tasks", "create", { title: "Blocked", category: "workshop" }),
      authority: "T0",
      idempotencyKey: "unauthorized-task",
    });
    assert.equal(unauthorized.status, "blocked");
    assert.equal(unauthorized.errorCode, "not-authorized");

    const dryRun = await service(tasks, reminders).execute({
      action: {
        ...approvedAction("tasks", "create", { title: "Dry run", category: "workshop" }),
        actionId: "action-task-dry-run",
        requestId: "request-task-dry-run",
      },
      authority: "T1",
      idempotencyKey: "dry-run-task",
      dryRun: true,
    });
    assert.equal(dryRun.status, "dry-run");
    assert.equal(tasks.creates.length, 0);
  });

  it("blocks every operation outside the exact reviewed allowlist", async () => {
    const tasks = new RecordingTaskStore();
    const reminders = new RecordingReminderStore();
    for (const [tool, operation] of [
      ["tasks", "update"],
      ["tasks", "remove"],
      ["reminders", "update"],
      ["reminders", "remove"],
      ["quotes", "send"],
    ] as const) {
      const result = await service(tasks, reminders).execute({
        action: {
          ...approvedAction(tool, operation, {}),
          actionId: `blocked-${tool}-${operation}`,
          requestId: `blocked-request-${tool}-${operation}`,
        },
        authority: "T1",
        idempotencyKey: `blocked-${tool}-${operation}`,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.errorCode, "not-allowlisted");
    }
    assert.equal(tasks.creates.length, 0);
    assert.equal(tasks.completions.length, 0);
    assert.equal(reminders.creates.length, 0);
    assert.equal(reminders.cancellations.length, 0);
  });
});

class ReschedulingReminderStore extends RecordingReminderStore {
  readonly reschedules: RescheduleControlledReminderInput[] = [];
  rescheduleResult: ControlledReminderRecord | null = null;

  async reschedule(
    input: RescheduleControlledReminderInput,
  ): Promise<ControlledReminderRecord | null> {
    this.reschedules.push(input);
    return this.rescheduleResult;
  }
}

describe("AM-017 reminders:reschedule allowlist (planned)", () => {
  function keys(reminders: RecordingReminderStore, reminderReschedule?: boolean) {
    return createToolExecutionDefinitions(
      new StubNoteStore(),
      new RecordingTaskStore(),
      reminders,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reminderReschedule === undefined ? {} : { reminderReschedule },
    ).map(({ tool, operation }) => `${tool}:${operation}`);
  }

  it("is absent unless explicitly enabled and supported by the store", () => {
    assert.equal(keys(new ReschedulingReminderStore()).includes("reminders:reschedule"), false);
    assert.equal(
      keys(new ReschedulingReminderStore(), false).includes("reminders:reschedule"),
      false,
    );
    assert.equal(
      keys(new RecordingReminderStore(), true).includes("reminders:reschedule"),
      false,
      "a store without reschedule never registers it",
    );
    assert.equal(
      keys(new ReschedulingReminderStore(), true).includes("reminders:reschedule"),
      true,
    );
    assert.equal(reminderRescheduleEnabledFromEnv({}), false);
    assert.equal(
      reminderRescheduleEnabledFromEnv({ JARVIS_REMINDER_RESCHEDULE_ENABLED: "1" }),
      false,
    );
    assert.equal(
      reminderRescheduleEnabledFromEnv({ JARVIS_REMINDER_RESCHEDULE_ENABLED: "true" }),
      true,
    );
  });

  it("is blocked as not allowlisted while AM-017 is not enabled", async () => {
    const reminders = new ReschedulingReminderStore();
    const result = await service(new RecordingTaskStore(), reminders).execute({
      action: approvedAction("reminders", "reschedule", {
        reminderId: "reminder-1",
        dueRaw: "friday",
      }),
      authority: "T1",
      idempotencyKey: "blocked-reschedule",
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "not-allowlisted");
    assert.equal(reminders.reschedules.length, 0);
  });

  it("when enabled, validates arguments and propagates the execution context", async () => {
    const reminders = new ReschedulingReminderStore();
    reminders.rescheduleResult = {
      id: "reminder-1",
      projectId: "project-1",
      title: "Order bar oil",
      dueRaw: "friday at 9 am",
      dueAt: 1_800_500_000_000,
      dueTimezone: "Australia/Sydney",
      createdAt: 1,
      updatedAt: 2,
      revision: 2,
    };
    const enabled = new ToolExecutionService(
      createToolExecutionDefinitions(
        new StubNoteStore(),
        new RecordingTaskStore(),
        reminders,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { reminderReschedule: true },
      ),
    );
    const result = await enabled.execute({
      action: approvedAction("reminders", "reschedule", {
        reminderId: "reminder-1",
        dueRaw: "friday at 9 am",
        dueAt: 1_800_500_000_000,
        dueTimezone: "Australia/Sydney",
      }),
      authority: "T1",
      idempotencyKey: "execute-reschedule",
      correlationId: "correlation-reschedule",
      source: "tool-action-http",
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(reminders.reschedules, [
      {
        projectId: "project-1",
        reminderId: "reminder-1",
        dueRaw: "friday at 9 am",
        dueAt: 1_800_500_000_000,
        dueTimezone: "Australia/Sydney",
        idempotencyKey: "execute-reschedule",
        actionFingerprint: result.actionFingerprint,
        sourceRequestId: "request-reminders-reschedule",
        correlationId: "correlation-reschedule",
        source: "tool-action-http",
      },
    ]);

    const definition = createToolExecutionDefinitions(
      new StubNoteStore(),
      new RecordingTaskStore(),
      reminders,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { reminderReschedule: true },
    ).find((entry) => entry.operation === "reschedule");
    assert.ok(definition);
    for (const value of [
      { reminderId: "reminder-1" },
      { reminderId: "reminder-1", dueRaw: "" },
      { reminderId: "reminder-1", dueRaw: "friday", dueAt: 1 },
      { reminderId: "reminder-1", dueRaw: "friday", dueTimezone: "UTC" },
      { reminderId: "reminder-1", dueRaw: "friday", title: "Renamed" },
    ]) {
      assert.equal(definition.schema.safeParse(value).success, false, JSON.stringify(value));
    }
  });
});
