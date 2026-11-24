import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import type { ToolAction, ToolActionService } from "../src/actions/toolActions.js";
import { InMemoryErrandStore } from "../src/errands/inMemoryErrandStore.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import type {
  ControlledReminderRecord,
  ControlledReminderStore,
  CreateControlledReminderInput,
} from "../src/reminders/controlledReminder.js";
import { captureCredentials } from "../src/settings/credentialsStatus.js";
import type {
  CompleteControlledTaskInput,
  ControlledTaskRecord,
  ControlledTaskStore,
  CreateControlledTaskInput,
} from "../src/tasks/controlledTask.js";
import { VOICE_COMMANDS, type VoiceCommand } from "../src/voice/voiceCommands.js";
import {
  VoiceConversationService,
  type VoiceConversationReasoner,
} from "../src/voice/voiceConversation.js";
import {
  VOICE_DIRECT_SOURCE,
  VOICE_UNDO_EXPIRED_REASON,
  VOICE_UNDO_NOTHING_REASON,
  VoiceDirectWriter,
  isDirectVoiceWrite,
  isVoiceUndoPhrase,
} from "../src/voice/voiceDirectWrite.js";
import { VoiceWriteTarget } from "../src/voice/voiceWriteTarget.js";

class Tasks implements ControlledTaskStore {
  readonly rows = new Map<string, ControlledTaskRecord>();
  readonly sources: string[] = [];
  #next = 0;
  async create(input: CreateControlledTaskInput): Promise<ControlledTaskRecord> {
    this.sources.push(input.source);
    const row: ControlledTaskRecord = {
      id: `task-${++this.#next}`,
      projectId: input.projectId,
      title: input.title,
      category: input.category,
      completed: false,
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async complete(input: CompleteControlledTaskInput): Promise<ControlledTaskRecord | null> {
    const row = this.rows.get(input.taskId);
    if (!row || row.projectId !== input.projectId) return null;
    row.completed = true;
    return row;
  }
  async get(projectId: string, taskId: string): Promise<ControlledTaskRecord | null> {
    const row = this.rows.get(taskId);
    return row && row.projectId === projectId ? row : null;
  }
  async cleanup(projectId: string, taskId: string): Promise<boolean> {
    const row = this.rows.get(taskId);
    if (!row || row.projectId !== projectId) return false;
    this.rows.delete(taskId);
    return true;
  }
  async reopen(projectId: string, taskId: string): Promise<ControlledTaskRecord | null> {
    const row = this.rows.get(taskId);
    if (!row || row.projectId !== projectId) return null;
    row.completed = false;
    return row;
  }
}

class Reminders implements ControlledReminderStore {
  readonly rows = new Map<string, ControlledReminderRecord>();
  #next = 0;
  async create(input: CreateControlledReminderInput): Promise<ControlledReminderRecord> {
    const row: ControlledReminderRecord = {
      id: `reminder-${++this.#next}`,
      projectId: input.projectId,
      title: input.title,
      ...(input.dueRaw === undefined ? {} : { dueRaw: input.dueRaw }),
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async cancel(): Promise<ControlledReminderRecord | null> {
    throw new Error("direct voice writes never cancel a reminder");
  }
  async get(_projectId: string, id: string): Promise<ControlledReminderRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async cleanup(_projectId: string, id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

function command(tool: string, operation: string): VoiceCommand {
  const found = [...VOICE_COMMANDS].find(
    (entry) => entry.proposes?.tool === tool && entry.proposes?.operation === operation,
  );
  if (found) return found;
  return {
    id: `client.test-${tool}-${operation}`,
    profile: "client",
    phrases: [],
    summary: "test",
    kind: "propose",
    criticality: "routine",
    requiresSpokenConfirmation: false,
    proposes: { tool, operation },
  } as unknown as VoiceCommand;
}

function writer(clock = { now: 1_000 }) {
  const tasks = new Tasks();
  const reminders = new Reminders();
  const errands = new InMemoryErrandStore();
  const direct = new VoiceDirectWriter({
    tasks,
    reminders,
    errands,
    clock: () => clock.now,
    undoWindowMs: 60_000,
  });
  return { tasks, reminders, errands, direct, clock };
}

describe("direct voice write scope", () => {
  it("covers adds and completions, never cancel, remove, reschedule or hardware", () => {
    for (const [tool, operation] of [
      ["tasks", "create"],
      ["reminders", "create"],
      ["errands", "create"],
      ["tasks", "complete"],
      ["errands", "complete"],
    ] as const) {
      assert.equal(isDirectVoiceWrite(command(tool, operation)), true, `${tool}:${operation}`);
    }
    for (const [tool, operation] of [
      ["reminders", "cancel"],
      ["reminders", "reschedule"],
      ["errands", "remove"],
      ["home", "announce"],
    ] as const) {
      assert.equal(isDirectVoiceWrite(command(tool, operation)), false, `${tool}:${operation}`);
    }
  });

  it("recognises spoken undo phrases only as whole utterances", () => {
    for (const phrase of ["undo", "Undo that", "scratch that", "take that back", "never mind"]) {
      assert.equal(isVoiceUndoPhrase(phrase), true, phrase);
    }
    for (const phrase of ["undo the milk task", "add undo", ""]) {
      assert.equal(isVoiceUndoPhrase(phrase), false, phrase);
    }
  });
});

describe("VoiceDirectWriter", () => {
  it("saves a task on the voice project and undoes it once", async () => {
    const { tasks, direct } = writer();
    const session = {};
    const saved = await direct.write({
      session,
      sessionId: "s1",
      projectId: "nolan-voice",
      command: command("tasks", "create"),
      capture: { title: "Order bar oil", category: "work" },
    });
    assert.deepEqual(saved, { status: "saved", undoExpiresAt: 61_000 });
    assert.equal(tasks.rows.size, 1);
    assert.equal([...tasks.rows.values()][0]?.projectId, "nolan-voice");
    assert.deepEqual(tasks.sources, [VOICE_DIRECT_SOURCE]);

    const undone = await direct.undo(session);
    assert.equal(undone.status, "undone");
    assert.equal(tasks.rows.size, 0);
    assert.deepEqual(await direct.undo(session), {
      status: "unavailable",
      reason: VOICE_UNDO_NOTHING_REASON,
    });
  });

  it("only undoes within the window, and only for the session that wrote", async () => {
    const { reminders, direct, clock } = writer();
    const mine = {};
    await direct.write({
      session: mine,
      sessionId: "s1",
      projectId: "nolan-voice",
      command: command("reminders", "create"),
      capture: { title: "Call Dave" },
    });
    assert.equal((await direct.undo({})).status, "unavailable", "another session cannot undo");
    clock.now += 60_000;
    assert.deepEqual(await direct.undo(mine), {
      status: "unavailable",
      reason: VOICE_UNDO_EXPIRED_REASON,
    });
    assert.equal(reminders.rows.size, 1, "an expired undo changes nothing");
  });

  it("reopens a completed task and errand on undo", async () => {
    const { tasks, errands, direct } = writer();
    const task = await tasks.create({
      projectId: "nolan-voice",
      title: "Milk",
      category: "personal",
      idempotencyKey: "k",
      actionFingerprint: "f",
      sourceRequestId: "r",
      correlationId: "c",
      source: "test",
    });
    const session = {};
    await direct.write({
      session,
      sessionId: "s1",
      projectId: "nolan-voice",
      command: command("tasks", "complete"),
      capture: { title: "Milk", targetId: task.id },
    });
    assert.equal(tasks.rows.get(task.id)?.completed, true);
    assert.equal((await direct.undo(session)).status, "undone");
    assert.equal(tasks.rows.get(task.id)?.completed, false);

    const errand = await errands.add({ title: "Bar oil" });
    await direct.write({
      session,
      sessionId: "s1",
      projectId: "nolan-voice",
      command: command("errands", "complete"),
      capture: { title: "Bar oil", targetId: errand.id },
    });
    assert.equal((await errands.get(errand.id))?.status, "done");
    assert.equal((await direct.undo(session)).status, "undone");
    assert.equal((await errands.get(errand.id))?.status, "open");
  });

  it("refuses a capture the executor would refuse, and anything outside its scope", async () => {
    const { tasks, direct } = writer();
    const refusedTask = await direct.write({
      session: {},
      sessionId: "s1",
      projectId: "nolan-voice",
      command: command("tasks", "create"),
      capture: { title: "No category" },
    });
    assert.equal(refusedTask.status, "refused");
    const refusedCancel = await direct.write({
      session: {},
      sessionId: "s1",
      projectId: "nolan-voice",
      command: command("reminders", "cancel"),
      capture: { title: "Rego", targetId: "reminder-1" },
    });
    assert.equal(refusedCancel.status, "refused");
    assert.equal(tasks.rows.size, 0);
  });
});

// ---- over HTTP ----

const openApps: NestFastifyApplication[] = [];
afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
});

class Actions implements ToolActionService {
  readonly rows: ToolAction[] = [];
  async stage(input: Parameters<ToolActionService["stage"]>[0]): Promise<ToolAction> {
    const row = {
      ...input,
      baseRevision: input.expectedRevision,
      state: "proposed",
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    } as unknown as ToolAction;
    this.rows.push(row);
    return row;
  }
  async get(): Promise<ToolAction | null> {
    return null;
  }
  async list(): Promise<ToolAction[]> {
    return this.rows;
  }
  async approve(): Promise<ToolAction> {
    throw new Error("voice never approves");
  }
  async reject(): Promise<ToolAction> {
    throw new Error("voice never rejects");
  }
}

function persistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("not used");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: forbidden,
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: forbidden,
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

async function open(options: {
  direct: boolean;
  commissioned?: boolean;
  reasoner?: VoiceConversationReasoner;
}) {
  const config: HttpAppConfig = {
    version: "0.1.0",
    sourceVersion: "voice-direct-test",
    deploymentVersion: null,
    timezone: "Australia/Melbourne",
    currentToken: "secret",
    previousToken: undefined,
  };
  const actions = new Actions();
  const stores = writer();
  const app = await createJarvisHttpApp({
    config,
    credentialsRuntime: captureCredentials({
      serviceToken: "secret",
      httpHost: "127.0.0.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    }),
    persistence: persistence(),
    providerName: "json",
    logger: false,
    toolActionService: actions,
    errandStore: stores.errands,
    voiceWriteTarget: new VoiceWriteTarget("nolan-voice", {
      revision: async () => (options.commissioned === false ? null : 2),
    }),
    voiceDirectWriter: options.direct ? stores.direct : null,
    ...(options.reasoner
      ? { voiceConversation: new VoiceConversationService({ reasoner: options.reasoner }) }
      : {}),
  });
  openApps.push(app);
  const headers = { authorization: "Bearer secret" };
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/voice/sessions",
    headers,
    payload: { profile: "client" },
  });
  const sessionId = created.json().sessionId as string;
  const say = async (transcript: string) =>
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/voice/sessions/${sessionId}/utterances`,
        headers,
        payload: { transcript, isFinal: true },
      })
    ).json();
  return { actions, ...stores, say };
}

describe("direct voice writes over HTTP", () => {
  it("saves a dictated task at once, with no confirm and no staged action", async () => {
    const { actions, tasks, say } = await open({ direct: true });
    const heard = await say("Nolan, add a work task: Order bar oil");
    assert.equal(heard.dispatch.decision, "saved");
    assert.equal(heard.dispatch.command.id, "client.capture-task");
    assert.equal(heard.dispatch.capture.title, "Order bar oil");
    assert.equal(typeof heard.dispatch.undoExpiresAt, "number");
    assert.equal(heard.pending, null, "nothing is left waiting for a confirm");
    assert.equal(actions.rows.length, 0, "nothing goes to the approvals page");
    assert.equal(tasks.rows.size, 1);

    const undone = await say("Nolan undo");
    assert.equal(undone.dispatch.decision, "undone");
    assert.equal(tasks.rows.size, 0);
    const again = await say("Nolan undo");
    assert.equal(again.dispatch.decision, "undo-unavailable");
    assert.equal(again.dispatch.reason, VOICE_UNDO_NOTHING_REASON);
  });

  it("saves a dictated errand at once", async () => {
    const { errands, say } = await open({ direct: true });
    const heard = await say("Nolan, add an errand: Bar oil");
    assert.equal(heard.dispatch.decision, "saved");
    assert.deepEqual(
      (await errands.list()).map((errand) => errand.title),
      ["Bar oil"],
    );
  });

  it("needs the wake word for both a write and an undo", async () => {
    const { tasks, say } = await open({ direct: true });
    const heard = await say("add a work task: Order bar oil");
    assert.notEqual(heard.dispatch.decision, "saved");
    assert.equal(tasks.rows.size, 0);
    assert.notEqual((await say("undo")).dispatch.decision, "undone");
  });

  it("keeps the read-back and staging when no direct writer is configured", async () => {
    const { actions, tasks, say } = await open({ direct: false });
    const heard = await say("Nolan, add a work task: Order bar oil");
    assert.equal(heard.dispatch.decision, "awaiting-confirmation");
    assert.equal((await say("Nolan confirm")).dispatch.decision, "proposed");
    assert.equal(actions.rows.length, 1);
    assert.equal(tasks.rows.size, 0);
  });

  it("falls back to the read-back when the voice project is not commissioned", async () => {
    const { tasks, say } = await open({ direct: true, commissioned: false });
    const heard = await say("Nolan, add a work task: Order bar oil");
    assert.equal(heard.dispatch.decision, "awaiting-confirmation");
    assert.equal(tasks.rows.size, 0);
  });
});

describe("direct voice writes from plain speech", () => {
  it("saves what NOLAN understood from plain speech at once, and undoes it", async () => {
    const { actions, errands, say } = await open({
      direct: true,
      reasoner: {
        async reply() {
          return { status: "proposed", proposal: { action: "add_errand", title: "Bar oil" } };
        },
      },
    });
    const heard = await say("Nolan, chuck some bar oil on the shopping list would ya");
    assert.equal(heard.dispatch.decision, "saved");
    assert.equal(heard.dispatch.command.id, "client.capture-errand");
    assert.deepEqual(heard.dispatch.capture, { title: "Bar oil" });
    assert.equal(heard.pending, null);
    assert.equal(actions.rows.length, 0, "nothing goes to the approvals page");
    assert.deepEqual(
      (await errands.list()).map((errand) => errand.title),
      ["Bar oil"],
    );

    assert.equal((await say("Nolan undo")).dispatch.decision, "undone");
    assert.equal((await errands.list()).length, 0);
  });

  it("still reads back anything riskier than an add or a tick-off", async () => {
    const { errands, say } = await open({
      direct: true,
      reasoner: {
        async reply() {
          return { status: "proposed", proposal: { action: "remove_errand", reference: "screws" } };
        },
      },
    });
    await errands.add({ title: "Screws" });
    const heard = await say("Nolan, forget about the screws mate");
    assert.equal(heard.dispatch.decision, "awaiting-confirmation");
    assert.equal(heard.dispatch.command.proposes.operation, "remove");
    assert.equal((await errands.list()).length, 1, "nothing is removed without a confirm");
  });
});
