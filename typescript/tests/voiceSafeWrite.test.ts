import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import {
  deriveToolExecutionIdempotencyKey,
  ToolExecutionService,
} from "../src/actions/toolExecution.js";
import type { ToolAction, ToolActionService } from "../src/actions/toolActions.js";
import {
  cancelReminderToolDefinition,
  completeTaskToolDefinition,
  createReminderToolDefinition,
  createTaskToolDefinition,
} from "../src/actions/taskReminderTools.js";
import {
  completeErrandToolDefinition,
  createErrandToolDefinition,
} from "../src/actions/errandTools.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { ErrandStore } from "../src/errands/errand.js";
import { InMemoryErrandStore } from "../src/errands/inMemoryErrandStore.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import type { ControlledReminderRecord } from "../src/reminders/controlledReminder.js";
import { captureCredentials, type CredentialsRuntime } from "../src/settings/credentialsStatus.js";
import type { ControlledTaskRecord } from "../src/tasks/controlledTask.js";
import {
  splitVoiceWakeWord,
  VOICE_COMPLETION_TARGET_REASON,
  voiceUtteranceForSession,
} from "../src/voice/voiceSafeWrite.js";
import { VoiceWriteTarget } from "../src/voice/voiceWriteTarget.js";

function credentials(host: string): CredentialsRuntime {
  return captureCredentials({
    serviceToken: "current-secret",
    httpHost: host,
    httpPort: 3000,
    mcpHost: "127.0.0.1",
    mcpPort: 8787,
    remoteGatewayEnabled: false,
    tlsTerminated: false,
    oidcConfigured: false,
    originsConfigured: false,
    persistenceProvider: "json",
  });
}

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "voice-safe-write-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function persistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("voice safe-write tests must not touch the JSON task or reminder list");
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

class MemoryActions implements ToolActionService {
  readonly rows = new Map<string, ToolAction>();
  approveCalls = 0;
  rejectCalls = 0;
  revokeCalls = 0;

  async stage(input: Parameters<ToolActionService["stage"]>[0]): Promise<ToolAction> {
    const proposal = {
      projectId: input.projectId,
      baseRevision: input.expectedRevision,
      tool: input.tool,
      operation: input.operation,
      arguments: input.arguments,
      rationale: input.rationale,
      requiredAuthority: input.requiredAuthority,
      destructive: input.destructive,
      idempotencyKey: input.idempotencyKey,
      proposedBy: input.proposedBy,
    };
    const existing = this.rows.get(input.actionId);
    if (existing) {
      const same =
        existing.projectId === proposal.projectId &&
        existing.baseRevision === proposal.baseRevision &&
        existing.tool === proposal.tool &&
        existing.operation === proposal.operation &&
        JSON.stringify(existing.arguments) === JSON.stringify(proposal.arguments) &&
        existing.rationale === proposal.rationale &&
        existing.requiredAuthority === proposal.requiredAuthority &&
        existing.destructive === proposal.destructive &&
        existing.idempotencyKey === proposal.idempotencyKey &&
        existing.proposedBy === proposal.proposedBy;
      if (!same) throw new Error("Tool action ID already exists with different contents.");
      return existing;
    }
    const staged: ToolAction = {
      actionId: input.actionId,
      requestId: input.requestId,
      projectId: input.projectId,
      baseRevision: input.expectedRevision,
      state: "proposed",
      tool: input.tool,
      operation: input.operation,
      arguments: input.arguments,
      rationale: input.rationale,
      requiredAuthority: input.requiredAuthority,
      destructive: input.destructive,
      idempotencyKey: input.idempotencyKey,
      proposedBy: input.proposedBy,
      createdAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
    };
    this.rows.set(input.actionId, staged);
    return staged;
  }

  async get(input: { actionId: string; projectId: string }): Promise<ToolAction | null> {
    const row = this.rows.get(input.actionId);
    if (!row || row.projectId !== input.projectId) return null;
    return row;
  }

  async list(): Promise<ToolAction[]> {
    return [...this.rows.values()];
  }

  async approve(input: {
    actionId: string;
    projectId: string;
    expectedRevision: number;
    approvalToken: string;
  }): Promise<ToolAction> {
    this.approveCalls += 1;
    if (!input.approvalToken) throw new Error("approval token required");
    const row = await this.get(input);
    if (!row) throw new Error("Tool action does not exist.");
    if (row.baseRevision !== input.expectedRevision) throw new Error("revision conflict");
    const approved: ToolAction = {
      ...row,
      state: "approved",
      approvedBy: "user",
      approvedAt: "2026-10-07T00:01:00.000Z",
      updatedAt: "2026-10-07T00:01:00.000Z",
    };
    this.rows.set(row.actionId, approved);
    return approved;
  }

  async reject(): Promise<ToolAction> {
    this.rejectCalls += 1;
    throw new Error("voice must not reject");
  }

  async revoke(): Promise<ToolAction> {
    this.revokeCalls += 1;
    throw new Error("voice must not revoke");
  }
}

class MemoryTasks {
  readonly records: ControlledTaskRecord[] = [];

  async create(input: {
    projectId: string;
    title: string;
    category: string;
    idempotencyKey: string;
  }): Promise<ControlledTaskRecord> {
    const record: ControlledTaskRecord = {
      id: `task-${this.records.length + 1}`,
      projectId: input.projectId,
      title: input.title,
      category: input.category,
      completed: false,
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    };
    this.records.push(record);
    return record;
  }

  async complete(): Promise<ControlledTaskRecord | null> {
    return null;
  }

  async get(): Promise<ControlledTaskRecord | null> {
    return null;
  }

  async cleanup(): Promise<boolean> {
    return false;
  }
}

class MemoryReminders {
  readonly records: ControlledReminderRecord[] = [];

  async create(input: {
    projectId: string;
    title: string;
    dueRaw?: string;
    dueAt?: number;
    dueTimezone?: string;
  }): Promise<ControlledReminderRecord> {
    const record: ControlledReminderRecord = {
      id: `reminder-${this.records.length + 1}`,
      projectId: input.projectId,
      title: input.title,
      ...(input.dueRaw === undefined ? {} : { dueRaw: input.dueRaw }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.dueTimezone === undefined ? {} : { dueTimezone: input.dueTimezone }),
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    };
    this.records.push(record);
    return record;
  }

  async cancel(): Promise<ControlledReminderRecord | null> {
    return null;
  }

  async get(): Promise<ControlledReminderRecord | null> {
    return null;
  }

  async cleanup(): Promise<boolean> {
    return false;
  }
}

const openApps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function makeApp(
  actions?: ToolActionService,
  errandStore?: ErrandStore,
  voiceWriteTarget?: VoiceWriteTarget,
  persistenceProvider: PersistenceProvider = persistence(),
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: persistenceProvider,
    providerName: "json",
    config: CONFIG,
    credentialsRuntime: credentials("10.0.0.5"),
    logger: false,
    ...(actions ? { toolActionService: actions } : {}),
    ...(errandStore ? { errandStore } : {}),
    ...(voiceWriteTarget ? { voiceWriteTarget } : {}),
  });
  openApps.push(app);
  return app;
}

async function openSession(app: NestFastifyApplication, profile = "client"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/voice/sessions",
    headers: AUTH,
    payload: { profile },
  });
  assert.equal(response.statusCode, 201);
  return response.json().sessionId as string;
}

function utter(app: NestFastifyApplication, sessionId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/voice/sessions/${sessionId}/utterances`,
    headers: AUTH,
    payload,
  });
}

const TARGET = { projectId: "project-1", expectedRevision: 1 };

async function executeLive(execution: ToolExecutionService, action: ToolAction) {
  return execution.execute({
    action,
    authority: "T3",
    idempotencyKey: deriveToolExecutionIdempotencyKey(action.actionId, "live"),
    approvalId: action.actionId,
    policyVersion: "totality-policy:v1",
    correlationId: action.requestId,
    source: "tool-action-http-controller",
  });
}

describe("voice safe writes", () => {
  it("stages a task through ToolActions and receipts it once on retry", async () => {
    const actions = new MemoryActions();
    const tasks = new MemoryTasks();
    const reminders = new MemoryReminders();
    const execution = new ToolExecutionService([
      createTaskToolDefinition(tasks),
      createReminderToolDefinition(reminders),
    ]);
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const payload = {
      transcript: "jarvis add a task",
      isFinal: true,
      ...TARGET,
      capture: { title: "Buy timber", category: "workshop" },
    };

    const first = await utter(app, sessionId, payload);
    assert.equal(first.statusCode, 200);
    const dispatch = first.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    assert.equal(dispatch.command.proposes.tool, "tasks");
    assert.equal(dispatch.command.proposes.operation, "create");
    assert.equal(typeof dispatch.toolActionId, "string");
    assert.equal(actions.rows.size, 1);
    assert.equal(actions.approveCalls, 0);
    const staged = actions.rows.get(dispatch.toolActionId);
    assert.ok(staged);
    assert.equal(staged.state, "proposed");
    assert.equal(staged.tool, "tasks");
    assert.equal(staged.operation, "create");
    assert.deepEqual(staged.arguments, { title: "Buy timber", category: "workshop" });
    assert.equal(tasks.records.length, 0, "staging must not execute");

    const approved = await actions.approve({
      actionId: staged.actionId,
      projectId: "project-1",
      expectedRevision: 1,
      approvalToken: "owner-token",
    });
    assert.equal(actions.approveCalls, 1);
    const receipt = await executeLive(execution, approved);
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.actionId, staged.actionId);
    assert.equal(tasks.records.length, 1);
    assert.equal(tasks.records[0]?.title, "Buy timber");

    const retry = await utter(app, sessionId, payload);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().dispatch.toolActionId, staged.actionId);
    assert.equal(actions.rows.size, 1);
    assert.equal(actions.approveCalls, 1, "voice retry must not approve");
    const replay = await executeLive(execution, approved);
    assert.equal(replay.receiptId, receipt.receiptId);
    assert.equal(replay.status, "succeeded");
    assert.equal(tasks.records.length, 1);
    assert.equal(reminders.records.length, 0);
  });

  it("stages a follow-up reminder through ToolActions and receipts it once on retry", async () => {
    const actions = new MemoryActions();
    const tasks = new MemoryTasks();
    const reminders = new MemoryReminders();
    const execution = new ToolExecutionService([
      createTaskToolDefinition(tasks),
      createReminderToolDefinition(reminders),
    ]);
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const payload = {
      transcript: "Jarvis remind me to follow up.",
      isFinal: true,
      ...TARGET,
      capture: { title: "Call the client" },
    };

    const first = await utter(app, sessionId, payload);
    assert.equal(first.statusCode, 200);
    const actionId = first.json().dispatch.toolActionId as string;
    assert.equal(typeof actionId, "string");
    const staged = actions.rows.get(actionId);
    assert.ok(staged);
    assert.equal(staged.tool, "reminders");
    assert.equal(staged.operation, "create");
    assert.deepEqual(staged.arguments, { title: "Call the client" });
    assert.equal(actions.approveCalls, 0);

    const approved = await actions.approve({
      actionId,
      projectId: "project-1",
      expectedRevision: 1,
      approvalToken: "owner-token",
    });
    const receipt = await executeLive(execution, approved);
    assert.equal(receipt.status, "succeeded");
    assert.equal(reminders.records.length, 1);
    assert.equal(reminders.records[0]?.title, "Call the client");

    const retry = await utter(app, sessionId, payload);
    assert.equal(retry.json().dispatch.toolActionId, actionId);
    assert.equal(actions.rows.size, 1);
    const replay = await executeLive(execution, approved);
    assert.equal(replay.receiptId, receipt.receiptId);
    assert.equal(reminders.records.length, 1);
    assert.equal(tasks.records.length, 0);
  });

  it("does not invent a reminder title when capture is missing or blank", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);

    const missing = await utter(app, sessionId, {
      transcript: "jarvis remind me to follow up",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(missing.statusCode, 200);
    assert.equal(missing.json().dispatch.decision, "proposed");
    assert.equal(missing.json().dispatch.toolActionId, undefined);
    assert.equal(
      missing.json().dispatch.reason,
      "Safe write was not staged: the capture is missing a required field.",
    );
    assert.equal(actions.rows.size, 0);

    const blank = await utter(app, sessionId, {
      transcript: "jarvis remind me to follow up",
      isFinal: true,
      ...TARGET,
      capture: { title: "   " },
    });
    assert.equal(blank.statusCode, 200);
    assert.equal(blank.json().dispatch.decision, "proposed");
    assert.equal(blank.json().dispatch.toolActionId, undefined);
    assert.equal(
      blank.json().dispatch.reason,
      "Safe write was not staged: the capture is missing a required field.",
    );
    assert.equal(actions.rows.size, 0);
    assert.equal(actions.approveCalls, 0);
  });

  it("keeps a consequential quote send as a proposal with no effect", async () => {
    const actions = new MemoryActions();
    const tasks = new MemoryTasks();
    const execution = new ToolExecutionService([createTaskToolDefinition(tasks)]);
    const app = await makeApp(actions);
    const sessionId = await openSession(app);

    const armed = await utter(app, sessionId, {
      transcript: "jarvis send the quote",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(armed.json().dispatch.decision, "awaiting-confirmation");
    assert.equal(armed.json().dispatch.toolActionId, undefined);

    const confirmed = await utter(app, sessionId, {
      transcript: "jarvis confirm",
      isFinal: true,
      ...TARGET,
    });
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    assert.equal(dispatch.command.proposes.operation, "quotes:send");
    assert.equal(dispatch.toolActionId, undefined);
    assert.equal(actions.rows.size, 0);
    assert.equal(actions.approveCalls, 0);
    assert.equal(tasks.records.length, 0);

    const drafted = await utter(app, sessionId, {
      transcript: "jarvis draft a quote",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(drafted.json().dispatch.decision, "proposed");
    assert.equal(drafted.json().dispatch.command.proposes.operation, "quotes:draft");
    assert.equal(drafted.json().dispatch.toolActionId, undefined);
    assert.equal(actions.rows.size, 0);
    void execution;
  });

  it("does not write an errand from the bare catalog phrase, even with a body capture", async () => {
    const actions = new MemoryActions();
    let errandWrites = 0;
    const errandStore: ErrandStore = {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      add: () => {
        errandWrites += 1;
        return Promise.reject(new Error("errand write"));
      },
      addOnce: () => {
        errandWrites += 1;
        return Promise.reject(new Error("errand write"));
      },
      update: () => {
        errandWrites += 1;
        return Promise.reject(new Error("errand write"));
      },
      remove: () => {
        errandWrites += 1;
        return Promise.reject(new Error("errand write"));
      },
    };
    const app = await makeApp(actions, errandStore);
    const sessionId = await openSession(app);
    const response = await utter(app, sessionId, {
      transcript: "jarvis add an errand",
      isFinal: true,
      ...TARGET,
      capture: { title: "Collect the trailer" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().dispatch.decision, "proposed");
    assert.equal(response.json().dispatch.toolActionId, undefined);
    assert.equal(response.json().dispatch.command.proposes.tool, "create_errand");
    assert.equal(actions.rows.size, 0);
    assert.equal(actions.approveCalls, 0);
    assert.equal(errandWrites, 0);
  });

  it("writes nothing without a wake word, for an unknown intent, or an uncommissioned target", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const capture = { title: "Buy timber", category: "workshop" };

    const bare = await utter(app, sessionId, {
      transcript: "add a task",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(bare.json().dispatch.decision, "proposed");
    assert.equal(bare.json().dispatch.toolActionId, undefined);
    assert.match(bare.json().dispatch.reason, /wake word/i);
    assert.equal(actions.rows.size, 0);

    const mismatched = await utter(app, sessionId, {
      transcript: "add a task",
      heardTranscript: "jarvis remind me to follow up",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(mismatched.json().dispatch.toolActionId, undefined);
    assert.equal(actions.rows.size, 0);

    const unknown = await utter(app, sessionId, {
      transcript: "jarvis make me a sandwich",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(unknown.json().dispatch.decision, "unrecognized");
    assert.equal(actions.rows.size, 0);

    const uncommissioned = await utter(app, sessionId, {
      transcript: "jarvis add a task",
      isFinal: true,
      capture,
    });
    assert.equal(uncommissioned.json().dispatch.toolActionId, undefined);
    assert.match(uncommissioned.json().dispatch.reason, /not commissioned/i);
    assert.equal(actions.rows.size, 0);

    const incomplete = await utter(app, sessionId, {
      transcript: "jarvis add a task",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(incomplete.json().dispatch.toolActionId, undefined);
    assert.match(incomplete.json().dispatch.reason, /capture/i);
    assert.equal(actions.rows.size, 0);

    const interim = await utter(app, sessionId, {
      transcript: "jarvis add a task",
      isFinal: false,
      ...TARGET,
      capture,
    });
    assert.equal(interim.json().dispatch.decision, "ignored-interim");
    assert.equal(actions.rows.size, 0);

    const ambiguous = await utter(app, sessionId, {
      transcript: "jarvis add a task",
      isFinal: true,
      alternatives: ["jarvis remind me to follow up"],
      ...TARGET,
      capture,
    });
    assert.equal(ambiguous.json().dispatch.decision, "ambiguous");
    assert.equal(actions.rows.size, 0);
    assert.equal(actions.approveCalls, 0);
  });

  it("accepts punctuation or whitespace right after the wake word", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const capture = { title: "Buy timber", category: "workshop" };

    const comma = await utter(app, sessionId, {
      transcript: "Jarvis, add a task",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(comma.statusCode, 200);
    assert.equal(comma.json().dispatch.decision, "proposed");
    const actionId = comma.json().dispatch.toolActionId;
    assert.equal(typeof actionId, "string");
    assert.equal(actions.rows.size, 1);
    assert.equal(actions.approveCalls, 0);

    for (const transcript of [
      "Jarvis! add a task",
      "Jarvis. add a task",
      "Jarvis? add a task",
      "Jarvis; add a task",
      "Jarvis: add a task",
    ]) {
      const marked = await utter(app, sessionId, {
        transcript,
        isFinal: true,
        ...TARGET,
        capture,
      });
      assert.equal(marked.statusCode, 200, transcript);
      assert.equal(marked.json().dispatch.toolActionId, actionId, transcript);
    }
    assert.equal(actions.rows.size, 1);

    for (const transcript of ["Jarvis", "Jarvis,", "Jarvis.", "Jarvis?", "Jarvis!"]) {
      const awake = await utter(app, sessionId, {
        transcript,
        isFinal: true,
        ...TARGET,
        capture,
      });
      assert.equal(awake.statusCode, 200, transcript);
      assert.equal(awake.json().dispatch.decision, "empty", transcript);
      assert.equal(awake.json().dispatch.toolActionId, undefined, transcript);
    }
    assert.equal(actions.rows.size, 1);

    const heard = await utter(app, sessionId, {
      transcript: "add a task",
      heardTranscript: "Jarvis, add a task",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(heard.json().dispatch.toolActionId, actionId);
    assert.equal(actions.rows.size, 1);
    assert.equal(actions.approveCalls, 0);
  });

  it("does not stage when the wake word is a longer word or is absent", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const capture = { title: "Buy timber", category: "workshop" };

    const prefixed = await utter(app, sessionId, {
      transcript: "Jarvisx add a task",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(prefixed.statusCode, 200);
    assert.equal(prefixed.json().dispatch.decision, "unrecognized");
    assert.equal(prefixed.json().dispatch.toolActionId, undefined);
    assert.equal(actions.rows.size, 0);

    const disguised = await utter(app, sessionId, {
      transcript: "add a task",
      heardTranscript: "Jarvisx add a task",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(disguised.json().dispatch.decision, "proposed");
    assert.equal(disguised.json().dispatch.toolActionId, undefined);
    assert.match(disguised.json().dispatch.reason, /wake word/i);
    assert.equal(actions.rows.size, 0);

    const bare = await utter(app, sessionId, {
      transcript: "add a task",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(bare.json().dispatch.toolActionId, undefined);
    assert.match(bare.json().dispatch.reason, /wake word/i);
    assert.equal(actions.rows.size, 0);
    assert.equal(actions.approveCalls, 0);
  });

  it("keeps the same revision idempotent and separates a different revision", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const capture = { title: "Buy timber", category: "workshop" };
    const payload = {
      transcript: "jarvis add a task",
      isFinal: true,
      projectId: "project-1",
      capture,
    };

    const first = await utter(app, sessionId, { ...payload, expectedRevision: 4 });
    assert.equal(first.statusCode, 200);
    const firstId = first.json().dispatch.toolActionId;
    assert.equal(typeof firstId, "string");
    assert.equal(actions.rows.get(firstId)?.baseRevision, 4);
    assert.equal(actions.rows.size, 1);

    const retry = await utter(app, sessionId, { ...payload, expectedRevision: 4 });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().dispatch.toolActionId, firstId);
    assert.equal(actions.rows.size, 1);
    assert.equal(actions.approveCalls, 0);

    const next = await utter(app, sessionId, { ...payload, expectedRevision: 5 });
    assert.equal(next.statusCode, 200);
    const nextId = next.json().dispatch.toolActionId;
    assert.equal(typeof nextId, "string");
    assert.notEqual(nextId, firstId);
    assert.equal(actions.rows.size, 2);
    assert.equal(actions.rows.get(nextId)?.baseRevision, 5);
    assert.equal(actions.rows.get(firstId)?.baseRevision, 4);
    assert.equal(actions.approveCalls, 0);
  });

  it("rejects a project target that supplies only one of projectId and expectedRevision", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const capture = { title: "Buy timber", category: "workshop" };

    const projectOnly = await utter(app, sessionId, {
      transcript: "jarvis add a task",
      isFinal: true,
      projectId: "project-1",
      capture,
    });
    assert.equal(projectOnly.statusCode, 422);
    assert.match(String(projectOnly.headers["content-type"]), /application\/problem\+json/);
    const projectProblem = projectOnly.json();
    assert.equal(projectProblem.type, "urn:jarvis:problem:invalid-voice-request");
    assert.equal(projectProblem.title, "Invalid Voice Request");
    assert.equal(projectProblem.status, 422);
    assert.match(projectProblem.detail, /together/i);
    assert.equal(actions.rows.size, 0);

    const revisionOnly = await utter(app, sessionId, {
      transcript: "jarvis add a task",
      isFinal: true,
      expectedRevision: 1,
      capture,
    });
    assert.equal(revisionOnly.statusCode, 422);
    assert.match(String(revisionOnly.headers["content-type"]), /application\/problem\+json/);
    const revisionProblem = revisionOnly.json();
    assert.equal(revisionProblem.type, "urn:jarvis:problem:invalid-voice-request");
    assert.equal(revisionProblem.title, "Invalid Voice Request");
    assert.equal(revisionProblem.status, 422);
    assert.match(revisionProblem.detail, /together/i);
    assert.equal(actions.rows.size, 0);
    assert.equal(actions.approveCalls, 0);
  });

  it("still stages when projectId and expectedRevision are both present", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const response = await utter(app, sessionId, {
      transcript: "jarvis add a task",
      isFinal: true,
      projectId: "project-1",
      expectedRevision: 1,
      capture: { title: "Buy timber", category: "workshop" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().dispatch.decision, "proposed");
    assert.equal(typeof response.json().dispatch.toolActionId, "string");
    assert.equal(actions.rows.size, 1);
    assert.equal(actions.rows.get(response.json().dispatch.toolActionId)?.state, "proposed");
    assert.equal(actions.approveCalls, 0);
  });

  it("still stages nothing when projectId and expectedRevision are both absent", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const response = await utter(app, sessionId, {
      transcript: "jarvis add a task",
      isFinal: true,
      capture: { title: "Buy timber", category: "workshop" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().dispatch.decision, "proposed");
    assert.equal(response.json().dispatch.toolActionId, undefined);
    assert.equal(
      response.json().dispatch.reason,
      "Safe write was not staged: the tool-action target is not commissioned.",
    );
    assert.equal(actions.rows.size, 0);
    assert.equal(actions.approveCalls, 0);
  });

  it("stages a microphone write only when the original transcript carried the wake word", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const capture = { title: "Buy timber", category: "workshop" };
    const heard = await utter(app, sessionId, {
      transcript: "add a task",
      heardTranscript: "jarvis add a task",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(typeof heard.json().dispatch.toolActionId, "string");
    assert.equal(actions.rows.size, 1);
    assert.equal(actions.approveCalls, 0);
  });

  it("writes nothing when the tool-action service is not commissioned", async () => {
    const app = await makeApp();
    const sessionId = await openSession(app);
    const response = await utter(app, sessionId, {
      transcript: "jarvis remind me to follow up",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().dispatch.decision, "proposed");
    assert.equal(response.json().dispatch.toolActionId, undefined);
    assert.match(response.json().dispatch.reason, /not commissioned/i);
  });

  it("routes an inferred safe-write through spoken confirmation before staging (#567)", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const capture = { title: "Call the client" };

    // A natural phrasing the exact parser declines and the dictation grammar
    // does not claim ("remind me to …" is now dictated with its own title).
    // It is interpreted but held for confirmation — nothing is staged yet.
    const first = await utter(app, sessionId, {
      transcript: "jarvis set a follow up reminder",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(first.statusCode, 200);
    const firstDispatch = first.json().dispatch;
    assert.equal(firstDispatch.decision, "awaiting-confirmation");
    assert.equal(firstDispatch.inferred, true);
    assert.equal(firstDispatch.command.id, "client.follow-up-reminder");
    assert.equal(firstDispatch.toolActionId, undefined);
    assert.equal(actions.rows.size, 0, "an inferred command stages nothing before confirmation");

    // Only an explicit spoken confirmation stages it, on the existing path.
    const confirmed = await utter(app, sessionId, {
      transcript: "jarvis confirm",
      isFinal: true,
      ...TARGET,
      capture,
    });
    assert.equal(confirmed.statusCode, 200);
    const confirmedDispatch = confirmed.json().dispatch;
    assert.equal(confirmedDispatch.decision, "proposed");
    assert.equal(typeof confirmedDispatch.toolActionId, "string");
    assert.equal(actions.rows.size, 1);
    const staged = actions.rows.get(confirmedDispatch.toolActionId);
    assert.ok(staged);
    assert.equal(staged.tool, "reminders");
    assert.equal(staged.operation, "create");
  });

  it("does not interpret a natural phrase that failed the wake word (#567)", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const out = await utter(app, sessionId, {
      transcript: "remind me to chase this up",
      isFinal: true,
      ...TARGET,
      capture: { title: "Call the client" },
    });
    assert.equal(out.statusCode, 200);
    assert.equal(out.json().dispatch.decision, "unrecognized");
    assert.equal(actions.rows.size, 0);
  });
});

describe("voice dictated safe writes", () => {
  it("reads back a spoken task, stages it only after confirm, and the owner approval creates it", async () => {
    const actions = new MemoryActions();
    const tasks = new MemoryTasks();
    const reminders = new MemoryReminders();
    const execution = new ToolExecutionService([
      createTaskToolDefinition(tasks),
      createReminderToolDefinition(reminders),
    ]);
    const app = await makeApp(actions);
    const sessionId = await openSession(app);

    const spoken = await utter(app, sessionId, {
      transcript: "Nolan, add a work task: order bar oil",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(spoken.statusCode, 200);
    const readBack = spoken.json();
    assert.equal(readBack.dispatch.decision, "awaiting-confirmation");
    assert.deepEqual(readBack.dispatch.capture, { title: "Order bar oil", category: "work" });
    assert.deepEqual(readBack.pending.capture, { title: "Order bar oil", category: "work" });
    assert.equal(actions.rows.size, 0, "a read-back stages nothing");

    // A body capture on the confirm turn can never replace what was read back.
    const confirmed = await utter(app, sessionId, {
      transcript: "Nolan confirm",
      isFinal: true,
      ...TARGET,
      capture: { title: "Something else entirely", category: "money" },
    });
    assert.equal(confirmed.statusCode, 200);
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    assert.deepEqual(dispatch.capture, { title: "Order bar oil", category: "work" });
    assert.equal(typeof dispatch.toolActionId, "string");
    const staged = actions.rows.get(dispatch.toolActionId);
    assert.ok(staged);
    assert.equal(staged.state, "proposed");
    assert.deepEqual(staged.arguments, { title: "Order bar oil", category: "work" });
    assert.equal(actions.approveCalls, 0, "voice never approves");
    assert.equal(tasks.records.length, 0, "staging must not execute");

    const approved = await actions.approve({
      actionId: staged.actionId,
      projectId: "project-1",
      expectedRevision: 1,
      approvalToken: "owner-token",
    });
    const receipt = await executeLive(execution, approved);
    assert.equal(receipt.status, "succeeded");
    assert.equal(tasks.records.length, 1);
    assert.equal(tasks.records[0]?.title, "Order bar oil");
    assert.equal(tasks.records[0]?.category, "work");

    const replay = await utter(app, sessionId, {
      transcript: "Nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(replay.json().dispatch.decision, "confirmation-not-pending");
    assert.equal(actions.rows.size, 1);
  });

  it("stages a dictated reminder after confirm", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    await utter(app, sessionId, {
      transcript: "nolan remind me to call Dave about the fence",
      isFinal: true,
      ...TARGET,
    });
    const confirmed = await utter(app, sessionId, {
      transcript: "nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    const staged = actions.rows.get(dispatch.toolActionId);
    assert.deepEqual(staged?.arguments, { title: "Call Dave about the fence" });
    assert.equal(staged?.tool, "reminders");
  });

  it("stages nothing for a dictation without the wake word", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const spoken = await utter(app, sessionId, {
      transcript: "add a task: order bar oil",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(spoken.json().dispatch.decision, "unrecognized");
    const confirm = await utter(app, sessionId, {
      transcript: "nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(confirm.json().dispatch.decision, "confirmation-not-pending");
    assert.equal(actions.rows.size, 0);
  });

  it("reports an uncommissioned target honestly after a confirmed dictation", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    await utter(app, sessionId, { transcript: "nolan add a task: order bar oil", isFinal: true });
    const confirmed = await utter(app, sessionId, { transcript: "nolan confirm", isFinal: true });
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    assert.equal(dispatch.toolActionId, undefined);
    assert.match(dispatch.reason, /not commissioned/);
    assert.equal(actions.rows.size, 0);
  });
});

class VoiceProjectRevisions {
  reads = 0;
  constructor(private readonly revisions: Map<string, number>) {}
  set(projectKey: string, revision: number): void {
    this.revisions.set(projectKey, revision);
  }
  async revision(projectKey: string): Promise<number | null> {
    this.reads += 1;
    return this.revisions.get(projectKey) ?? null;
  }
}

describe("voice writes on the dedicated voice project", () => {
  it("stages a HUD dictation with no client target against the voice project's current revision", async () => {
    const actions = new MemoryActions();
    const tasks = new MemoryTasks();
    const execution = new ToolExecutionService([createTaskToolDefinition(tasks)]);
    const revisions = new VoiceProjectRevisions(new Map([["nolan-voice", 3]]));
    const app = await makeApp(actions, undefined, new VoiceWriteTarget("nolan-voice", revisions));
    const sessionId = await openSession(app);

    // Exactly what the HUD microphone sends: no projectId, no expectedRevision.
    const spoken = await utter(app, sessionId, {
      transcript: "Nolan, add a work task: order bar oil",
      isFinal: true,
    });
    assert.equal(spoken.json().dispatch.decision, "awaiting-confirmation");
    assert.equal(revisions.reads, 0, "a read-back resolves nothing");
    assert.equal(actions.rows.size, 0);

    const confirmed = await utter(app, sessionId, { transcript: "Nolan confirm", isFinal: true });
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    assert.equal(typeof dispatch.toolActionId, "string");
    assert.equal(dispatch.reason, undefined);
    const staged = actions.rows.get(dispatch.toolActionId);
    assert.ok(staged);
    assert.equal(staged.projectId, "nolan-voice");
    assert.equal(staged.baseRevision, 3);
    assert.equal(staged.state, "proposed");
    assert.deepEqual(staged.arguments, { title: "Order bar oil", category: "work" });
    assert.equal(actions.approveCalls, 0, "voice never approves");
    assert.equal(tasks.records.length, 0, "staging never executes");

    const approved = await actions.approve({
      actionId: staged.actionId,
      projectId: "nolan-voice",
      expectedRevision: 3,
      approvalToken: "owner-token",
    });
    const receipt = await executeLive(execution, approved);
    assert.equal(receipt.status, "succeeded");
    assert.equal(tasks.records.length, 1);
    assert.equal(tasks.records[0]?.projectId, "nolan-voice");
    assert.equal(tasks.records[0]?.title, "Order bar oil");
  });

  it("reads the revision at confirm time, so a bumped project is never staged stale", async () => {
    const actions = new MemoryActions();
    const revisions = new VoiceProjectRevisions(new Map([["nolan-voice", 1]]));
    const app = await makeApp(actions, undefined, new VoiceWriteTarget("nolan-voice", revisions));
    const sessionId = await openSession(app);
    await utter(app, sessionId, { transcript: "nolan remind me to call Dave", isFinal: true });
    revisions.set("nolan-voice", 2);
    const confirmed = await utter(app, sessionId, { transcript: "nolan confirm", isFinal: true });
    const staged = actions.rows.get(confirmed.json().dispatch.toolActionId);
    assert.equal(staged?.projectId, "nolan-voice");
    assert.equal(staged?.baseRevision, 2);
    assert.equal(staged?.tool, "reminders");
  });

  it("an explicit request target still wins over the voice project", async () => {
    const actions = new MemoryActions();
    const revisions = new VoiceProjectRevisions(new Map([["nolan-voice", 1]]));
    const app = await makeApp(actions, undefined, new VoiceWriteTarget("nolan-voice", revisions));
    const sessionId = await openSession(app);
    await utter(app, sessionId, { transcript: "nolan add a task: order bar oil", isFinal: true });
    const confirmed = await utter(app, sessionId, {
      transcript: "nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    const staged = actions.rows.get(confirmed.json().dispatch.toolActionId);
    assert.equal(staged?.projectId, "project-1");
    assert.equal(revisions.reads, 0);
  });

  it("stages nothing and says how to fix it when the voice project is not commissioned", async () => {
    const actions = new MemoryActions();
    const revisions = new VoiceProjectRevisions(new Map());
    const app = await makeApp(actions, undefined, new VoiceWriteTarget("nolan-voice", revisions));
    const sessionId = await openSession(app);
    await utter(app, sessionId, { transcript: "nolan add a task: order bar oil", isFinal: true });
    const confirmed = await utter(app, sessionId, { transcript: "nolan confirm", isFinal: true });
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    assert.equal(dispatch.toolActionId, undefined);
    assert.match(dispatch.reason, /voice project "nolan-voice" is not commissioned/);
    assert.match(dispatch.reason, /commission:voice-project/);
    assert.equal(actions.rows.size, 0);
  });

  it("fails closed when the voice project cannot be read", async () => {
    const actions = new MemoryActions();
    const broken = {
      async revision(): Promise<number | null> {
        throw new Error("convex down");
      },
    };
    const app = await makeApp(actions, undefined, new VoiceWriteTarget("nolan-voice", broken));
    const sessionId = await openSession(app);
    await utter(app, sessionId, { transcript: "nolan add a task: order bar oil", isFinal: true });
    const confirmed = await utter(app, sessionId, { transcript: "nolan confirm", isFinal: true });
    assert.equal(
      confirmed.json().dispatch.reason,
      "Safe write was not staged: the voice project could not be read.",
    );
    assert.equal(actions.rows.size, 0);
  });

  it("never resolves the voice project for an unwoken or non-write turn", async () => {
    const actions = new MemoryActions();
    const revisions = new VoiceProjectRevisions(new Map([["nolan-voice", 1]]));
    const app = await makeApp(actions, undefined, new VoiceWriteTarget("nolan-voice", revisions));
    const sessionId = await openSession(app);
    const unwoken = await utter(app, sessionId, { transcript: "add a task", isFinal: true });
    assert.equal(unwoken.json().dispatch.toolActionId, undefined);
    await utter(app, sessionId, { transcript: "nolan open tasks", isFinal: true });
    assert.equal(revisions.reads, 0);
    assert.equal(actions.rows.size, 0);
  });
});

describe("voice dictated reminder due times", () => {
  it("stages the spoken due time with the reminder and the approved reminder is dated", async () => {
    const actions = new MemoryActions();
    const reminders = new MemoryReminders();
    const execution = new ToolExecutionService([createReminderToolDefinition(reminders)]);
    const app = await makeApp(actions);
    const sessionId = await openSession(app);

    const before = Date.now();
    const spoken = await utter(app, sessionId, {
      transcript: "Nolan, remind me to call Dave tomorrow at 7 am",
      isFinal: true,
      ...TARGET,
    });
    const readBack = spoken.json().dispatch;
    assert.equal(readBack.decision, "awaiting-confirmation");
    assert.equal(readBack.capture.title, "Call Dave");
    assert.equal(readBack.capture.dueRaw, "tomorrow at 7 am");
    assert.equal(readBack.capture.dueTimezone, "Australia/Melbourne");
    assert.ok(readBack.capture.dueAt > before, "tomorrow is in the future");
    assert.ok(readBack.capture.dueAt < before + 2 * 24 * 60 * 60 * 1_000);
    assert.equal(actions.rows.size, 0);

    const confirmed = await utter(app, sessionId, {
      transcript: "Nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    const dispatch = confirmed.json().dispatch;
    const staged = actions.rows.get(dispatch.toolActionId);
    assert.ok(staged);
    assert.deepEqual(staged.arguments, {
      title: "Call Dave",
      dueRaw: "tomorrow at 7 am",
      dueAt: readBack.capture.dueAt,
      dueTimezone: "Australia/Melbourne",
    });

    const approved = await actions.approve({
      actionId: staged.actionId,
      projectId: "project-1",
      expectedRevision: 1,
      approvalToken: "owner-token",
    });
    const receipt = await executeLive(execution, approved);
    assert.equal(receipt.status, "succeeded");
    assert.equal(reminders.records.length, 1);
    assert.equal(reminders.records[0]?.dueAt, readBack.capture.dueAt);
    assert.equal(reminders.records[0]?.dueRaw, "tomorrow at 7 am");
  });

  it("a request-body capture cannot add a due time to a voice reminder", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const response = await utter(app, sessionId, {
      transcript: "jarvis remind me to follow up",
      isFinal: true,
      ...TARGET,
      capture: { title: "Follow up", dueAt: 1, dueTimezone: "UTC", dueRaw: "x" },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(actions.rows.size, 0);
  });
});

describe("voice dictation casing end to end", () => {
  it("splits the wake word but keeps the command's casing", () => {
    assert.deepEqual(splitVoiceWakeWord("Nolan, add a task: call Dave"), {
      heard: true,
      rest: "add a task: call dave",
      restCased: "add a task: call Dave",
    });
    const prepared = voiceUtteranceForSession({
      transcript: "add a task: call Dave",
      heardTranscript: "Nolan add a task: call Dave",
    });
    assert.equal(prepared.wakeAuthorized, true);
    assert.equal(prepared.transcript, "add a task: call Dave");
  });

  it("stages a HUD-shaped dictation with the spoken casing", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions);
    const sessionId = await openSession(app);
    const spoken = await utter(app, sessionId, {
      transcript: "add a work task: quote the Smith fence for the BBQ area",
      heardTranscript: "Nolan, add a work task: quote the Smith fence for the BBQ area",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(spoken.json().dispatch.decision, "awaiting-confirmation");
    assert.equal(spoken.json().dispatch.capture.title, "Quote the Smith fence for the BBQ area");
    const confirmed = await utter(app, sessionId, {
      transcript: "Nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    const staged = actions.rows.get(confirmed.json().dispatch.toolActionId);
    assert.deepEqual(staged?.arguments, {
      title: "Quote the Smith fence for the BBQ area",
      category: "work",
    });
  });
});

describe("voice dictated errands", () => {
  it("reads a spoken errand back, stages it on confirm, and the approved errand is written once", async () => {
    const actions = new MemoryActions();
    const errands = new InMemoryErrandStore();
    const execution = new ToolExecutionService([createErrandToolDefinition(errands)]);
    const app = await makeApp(actions, errands);
    const sessionId = await openSession(app);

    const spoken = await utter(app, sessionId, {
      transcript: "Nolan, add an errand: silicone for the Smith deck",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(spoken.statusCode, 200);
    const readBack = spoken.json().dispatch;
    assert.equal(readBack.decision, "awaiting-confirmation");
    assert.equal(readBack.command.id, "client.capture-errand");
    assert.deepEqual(readBack.command.proposes, { tool: "errands", operation: "create" });
    assert.deepEqual(readBack.capture, { title: "Silicone for the Smith deck" });
    assert.equal(actions.rows.size, 0);
    assert.equal((await errands.list()).length, 0);

    const confirmed = await utter(app, sessionId, {
      transcript: "Nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    const staged = actions.rows.get(dispatch.toolActionId);
    assert.ok(staged);
    assert.equal(staged.tool, "errands");
    assert.equal(staged.operation, "create");
    assert.deepEqual(staged.arguments, { title: "Silicone for the Smith deck" });
    assert.equal(staged.state, "proposed");
    assert.equal(actions.approveCalls, 0);
    // Staging writes nothing: the errand exists only after owner approval.
    assert.equal((await errands.list()).length, 0);

    const again = await utter(app, sessionId, {
      transcript: "Nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(again.json().dispatch.decision, "confirmation-not-pending");
    assert.equal(actions.rows.size, 1);

    const approved = await actions.approve({
      actionId: staged.actionId,
      projectId: "project-1",
      expectedRevision: 1,
      approvalToken: "owner-token",
    });
    const receipt = await executeLive(execution, approved);
    assert.equal(receipt.status, "succeeded");
    const retried = await executeLive(execution, approved);
    assert.equal(retried.status, "succeeded");
    const written = await errands.list();
    assert.equal(written.length, 1);
    assert.equal(written[0]?.title, "Silicone for the Smith deck");
    assert.equal(written[0]?.status, "open");
    // The governing ToolAction project is not an errand's business-project link.
    assert.equal(written[0]?.projectId, undefined);

    const listed = await app.inject({ method: "GET", url: "/api/v1/errands", headers: AUTH });
    assert.equal(listed.json().count, 1);
  });

  it("accepts the list form and refuses an errand dictation that chains an action", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions, new InMemoryErrandStore());
    const sessionId = await openSession(app);

    const listForm = await utter(app, sessionId, {
      transcript: "Nolan add milk to the errands",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(listForm.json().dispatch.decision, "awaiting-confirmation");
    assert.deepEqual(listForm.json().dispatch.capture, { title: "Milk" });
    await utter(app, sessionId, { transcript: "Nolan cancel", isFinal: true, ...TARGET });

    const chained = await utter(app, sessionId, {
      transcript: "Nolan add an errand: milk and send the quote",
      isFinal: true,
      ...TARGET,
    });
    assert.notEqual(chained.json().dispatch.decision, "awaiting-confirmation");
    const confirm = await utter(app, sessionId, {
      transcript: "Nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(confirm.json().dispatch.toolActionId, undefined);
    assert.equal(actions.rows.size, 0);
  });

  it("a request-body capture on confirm cannot retitle a voice errand or add task fields", async () => {
    const actions = new MemoryActions();
    const app = await makeApp(actions, new InMemoryErrandStore());
    const sessionId = await openSession(app);
    await utter(app, sessionId, {
      transcript: "Nolan add an errand: bar oil",
      isFinal: true,
      ...TARGET,
    });
    const confirmed = await utter(app, sessionId, {
      transcript: "Nolan confirm",
      isFinal: true,
      ...TARGET,
      capture: { title: "Something else", category: "work" },
    });
    // The confirmed capture is exactly the read-back; the body capture is ignored.
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    assert.equal(actions.rows.size, 1);
    assert.deepEqual(actions.rows.get(dispatch.toolActionId)?.arguments, { title: "Bar oil" });
  });
});

/** One task table seen both ways: the resolver lists it, the executor completes it. */
class TaskTable {
  readonly rows: Array<ControlledTaskRecord & { projectId?: string }> = [];

  add(title: string, projectId?: string): string {
    const id = `task-${this.rows.length + 1}`;
    this.rows.push({
      id,
      title,
      category: "personal",
      completed: false,
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      projectId: projectId as string,
    });
    return id;
  }

  provider(): PersistenceProvider {
    return { ...persistence(), listTasks: async () => this.rows.map((row) => ({ ...row })) };
  }

  async create(): Promise<ControlledTaskRecord> {
    throw new Error("not used");
  }

  async complete(input: {
    projectId: string;
    taskId: string;
  }): Promise<ControlledTaskRecord | null> {
    const row = this.rows.find((r) => r.id === input.taskId && r.projectId === input.projectId);
    if (!row) return null;
    row.completed = true;
    row.completedAt = 2;
    return { ...row };
  }

  async get(): Promise<ControlledTaskRecord | null> {
    return null;
  }

  async cleanup(): Promise<boolean> {
    return false;
  }
}

describe("voice spoken completions", () => {
  async function completionApp(table: TaskTable, errands = new InMemoryErrandStore()) {
    const actions = new MemoryActions();
    const revisions = new VoiceProjectRevisions(new Map([["nolan-voice", 4]]));
    const app = await makeApp(
      actions,
      errands,
      new VoiceWriteTarget("nolan-voice", revisions),
      table.provider(),
    );
    return { actions, app, sessionId: await openSession(app) };
  }

  it("ticks off a voice-captured task by part of its title, after read-back, confirm and approval", async () => {
    const table = new TaskTable();
    const taskId = table.add("Order bar oil", "nolan-voice");
    table.add("Quote the Smith fence", "nolan-voice");
    const { actions, app, sessionId } = await completionApp(table);

    const spoken = await utter(app, sessionId, {
      transcript: "Nolan, tick off bar oil",
      isFinal: true,
    });
    const readBack = spoken.json().dispatch;
    assert.equal(readBack.decision, "awaiting-confirmation");
    assert.equal(readBack.command.id, "client.complete-task");
    assert.deepEqual(readBack.command.proposes, { tool: "tasks", operation: "complete" });
    // The read-back names the full stored title and the server-resolved id.
    assert.deepEqual(readBack.capture, { title: "Order bar oil", targetId: taskId });
    assert.equal(actions.rows.size, 0);
    assert.equal(table.rows[0]?.completed, false);

    const confirmed = await utter(app, sessionId, { transcript: "Nolan confirm", isFinal: true });
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    const staged = actions.rows.get(dispatch.toolActionId);
    assert.ok(staged);
    assert.equal(staged.tool, "tasks");
    assert.equal(staged.operation, "complete");
    assert.equal(staged.projectId, "nolan-voice");
    assert.equal(staged.baseRevision, 4);
    assert.deepEqual(staged.arguments, { taskId });
    assert.equal(actions.approveCalls, 0, "voice never approves");
    assert.equal(table.rows[0]?.completed, false, "staging never executes");

    const approved = await actions.approve({
      actionId: staged.actionId,
      projectId: "nolan-voice",
      expectedRevision: 4,
      approvalToken: "owner-token",
    });
    const execution = new ToolExecutionService([completeTaskToolDefinition(table)]);
    assert.equal((await executeLive(execution, approved)).status, "succeeded");
    assert.equal(table.rows[0]?.completed, true);
    assert.equal(table.rows[1]?.completed, false);
  });

  it("marks one open errand done, and only after approval and execution", async () => {
    const errands = new InMemoryErrandStore();
    await errands.add({ title: "Silicone for the deck" });
    const milk = await errands.add({ title: "Milk" });
    const { actions, app, sessionId } = await completionApp(new TaskTable(), errands);

    const spoken = await utter(app, sessionId, {
      transcript: "Nolan mark the errand milk as done",
      isFinal: true,
    });
    assert.equal(spoken.json().dispatch.decision, "awaiting-confirmation");
    assert.deepEqual(spoken.json().dispatch.capture, { title: "Milk", targetId: milk.id });

    const confirmed = await utter(app, sessionId, { transcript: "Nolan confirm", isFinal: true });
    const staged = actions.rows.get(confirmed.json().dispatch.toolActionId);
    assert.ok(staged);
    assert.equal(`${staged.tool}:${staged.operation}`, "errands:complete");
    assert.deepEqual(staged.arguments, { errandId: milk.id });
    assert.equal((await errands.get(milk.id))?.status, "open");

    const approved = await actions.approve({
      actionId: staged.actionId,
      projectId: "nolan-voice",
      expectedRevision: 4,
      approvalToken: "owner-token",
    });
    const execution = new ToolExecutionService([completeErrandToolDefinition(errands)]);
    assert.equal((await executeLive(execution, approved)).status, "succeeded");
    assert.equal((await errands.get(milk.id))?.status, "done");
    const open = (await errands.list()).filter((errand) => errand.status === "open");
    assert.deepEqual(
      open.map((errand) => errand.title),
      ["Silicone for the deck"],
    );
  });

  it("arms nothing when the reference is missing, ambiguous or not completable by voice", async () => {
    const table = new TaskTable();
    table.add("Order bar oil", "nolan-voice");
    table.add("Change the oil filter", "nolan-voice");
    table.add("Order chain", undefined); // captured on the HUD, outside the voice project
    const { actions, app, sessionId } = await completionApp(table);

    const cases: Array<[string, RegExp]> = [
      ["Nolan tick off oil", /2 open items match “Oil”\. Say more of the title\./],
      ["Nolan tick off the sprocket", /No open task or errand matches “Sprocket”/],
      ["Nolan tick off order chain", /“Order chain” was not captured by voice/],
      ["Nolan mark the errand bar oil done", /No open errand matches “Bar oil”/],
    ];
    for (const [transcript, reason] of cases) {
      const response = await utter(app, sessionId, { transcript, isFinal: true });
      const dispatch = response.json().dispatch;
      assert.equal(dispatch.decision, "completion-unresolved", transcript);
      assert.match(dispatch.reason, reason, transcript);
      assert.equal(dispatch.capture, undefined, transcript);
      assert.equal(response.json().pending, null, transcript);
      const confirm = await utter(app, sessionId, { transcript: "Nolan confirm", isFinal: true });
      assert.equal(confirm.json().dispatch.decision, "confirmation-not-pending", transcript);
    }
    assert.equal(actions.rows.size, 0);
    assert.equal(table.rows.filter((row) => row.completed).length, 0);
  });

  it("stages a completion only on the voice project, never on a request-supplied target", async () => {
    const table = new TaskTable();
    table.add("Order bar oil", "nolan-voice");
    const { actions, app, sessionId } = await completionApp(table);
    await utter(app, sessionId, { transcript: "Nolan tick off bar oil", isFinal: true });
    const confirmed = await utter(app, sessionId, {
      transcript: "Nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(confirmed.json().dispatch.toolActionId, undefined);
    assert.equal(confirmed.json().dispatch.reason, VOICE_COMPLETION_TARGET_REASON);
    assert.equal(actions.rows.size, 0);
  });

  it("never takes a completion target from the request body", async () => {
    const table = new TaskTable();
    table.add("Order bar oil", "nolan-voice");
    const { actions, app, sessionId } = await completionApp(table);
    const response = await utter(app, sessionId, {
      transcript: "Nolan add a task",
      isFinal: true,
      capture: { title: "Order bar oil", targetId: "task-1" },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(actions.rows.size, 0);
  });
});

/** One reminder table seen by both the resolver (listReminders) and the executor. */
class ReminderTable {
  readonly rows: ControlledReminderRecord[] = [];

  add(title: string, projectId: string, extra: Partial<ControlledReminderRecord> = {}): string {
    const id = `reminder-${this.rows.length + 1}`;
    this.rows.push({ id, projectId, title, createdAt: 1, updatedAt: 1, revision: 1, ...extra });
    return id;
  }

  provider(): PersistenceProvider {
    return {
      ...persistence(),
      listReminders: async () => this.rows.map((row) => ({ ...row })),
    };
  }

  async create(): Promise<ControlledReminderRecord> {
    throw new Error("not used");
  }

  async cancel(input: {
    projectId: string;
    reminderId: string;
  }): Promise<ControlledReminderRecord | null> {
    const index = this.rows.findIndex(
      (row) => row.id === input.reminderId && row.projectId === input.projectId,
    );
    if (index < 0) return null;
    // Like the Convex store: the cancelled reminder leaves the live list.
    const [row] = this.rows.splice(index, 1) as [ControlledReminderRecord];
    return { ...row, cancelledAt: 2, revision: row.revision + 1 };
  }

  async get(): Promise<ControlledReminderRecord | null> {
    return null;
  }

  async cleanup(): Promise<boolean> {
    return false;
  }
}

describe("voice spoken reminder cancellations", () => {
  async function cancelApp(table: ReminderTable) {
    const actions = new MemoryActions();
    const revisions = new VoiceProjectRevisions(new Map([["nolan-voice", 4]]));
    const app = await makeApp(
      actions,
      new InMemoryErrandStore(),
      new VoiceWriteTarget("nolan-voice", revisions),
      table.provider(),
    );
    return { actions, app, sessionId: await openSession(app) };
  }

  it("cancels one voice-captured reminder, after read-back, confirm and approval", async () => {
    const table = new ReminderTable();
    const barOil = table.add("Order bar oil", "nolan-voice", {
      dueRaw: "tomorrow at 7 am",
      dueAt: 1_800_000_000_000,
      dueTimezone: "Australia/Sydney",
    });
    table.add("Call Dave", "nolan-voice");
    const { actions, app, sessionId } = await cancelApp(table);

    const spoken = await utter(app, sessionId, {
      transcript: "Nolan, cancel the bar oil reminder",
      isFinal: true,
    });
    const readBack = spoken.json().dispatch;
    assert.equal(readBack.decision, "awaiting-confirmation");
    assert.equal(readBack.command.id, "client.cancel-reminder");
    assert.deepEqual(readBack.command.proposes, { tool: "reminders", operation: "cancel" });
    assert.deepEqual(readBack.capture, { title: "Order bar oil", targetId: barOil });
    assert.equal(actions.rows.size, 0);

    const confirmed = await utter(app, sessionId, { transcript: "Nolan confirm", isFinal: true });
    const dispatch = confirmed.json().dispatch;
    assert.equal(dispatch.decision, "proposed");
    const staged = actions.rows.get(dispatch.toolActionId);
    assert.ok(staged);
    assert.equal(`${staged.tool}:${staged.operation}`, "reminders:cancel");
    assert.equal(staged.projectId, "nolan-voice");
    assert.equal(staged.baseRevision, 4);
    assert.deepEqual(staged.arguments, { reminderId: barOil });
    assert.equal(actions.approveCalls, 0, "voice never approves");
    assert.equal(table.rows.length, 2, "staging never executes");

    const approved = await actions.approve({
      actionId: staged.actionId,
      projectId: "nolan-voice",
      expectedRevision: 4,
      approvalToken: "owner-token",
    });
    const execution = new ToolExecutionService([cancelReminderToolDefinition(table)]);
    assert.equal((await executeLive(execution, approved)).status, "succeeded");
    assert.deepEqual(
      table.rows.map((row) => row.title),
      ["Call Dave"],
    );
  });

  it("understands the other spoken forms", async () => {
    const table = new ReminderTable();
    const dave = table.add("Call Dave about the trailer", "nolan-voice");
    const { app, sessionId } = await cancelApp(table);
    for (const transcript of [
      "Nolan cancel my reminder to call Dave",
      "Nolan delete the reminder: call Dave about the trailer",
      "Nolan scrap the reminder about the trailer",
    ]) {
      const response = await utter(app, sessionId, { transcript, isFinal: true });
      const readBack = response.json().dispatch;
      assert.equal(readBack.decision, "awaiting-confirmation", transcript);
      assert.deepEqual(
        readBack.capture,
        { title: "Call Dave about the trailer", targetId: dave },
        transcript,
      );
    }
  });

  it("arms nothing when the reference is missing, ambiguous or outside the voice project", async () => {
    const table = new ReminderTable();
    table.add("Order bar oil", "nolan-voice");
    table.add("Change the oil filter", "nolan-voice");
    table.add("Renew the rego", "hud-project"); // captured on the HUD
    const { actions, app, sessionId } = await cancelApp(table);

    const cases: Array<[string, RegExp]> = [
      ["Nolan cancel the oil reminder", /2 reminders match “Oil”\. Say more of the title\./],
      ["Nolan cancel the reminder to buy a sprocket", /No reminder matches “Buy a sprocket”/],
      [
        "Nolan cancel the rego reminder",
        /Reminder “Renew the rego” was not captured by voice, so voice cannot cancel it/,
      ],
    ];
    for (const [transcript, reason] of cases) {
      const response = await utter(app, sessionId, { transcript, isFinal: true });
      const dispatch = response.json().dispatch;
      assert.equal(dispatch.decision, "completion-unresolved", transcript);
      assert.equal(dispatch.command.id, "client.cancel-reminder", transcript);
      assert.match(dispatch.reason, reason, transcript);
      assert.equal(dispatch.capture, undefined, transcript);
      assert.equal(response.json().pending, null, transcript);
      const confirm = await utter(app, sessionId, { transcript: "Nolan confirm", isFinal: true });
      assert.equal(confirm.json().dispatch.decision, "confirmation-not-pending", transcript);
    }
    assert.equal(actions.rows.size, 0);
    assert.equal(table.rows.length, 3);
  });

  it("keeps the bare control word: “Nolan cancel” still only drops a pending capture", async () => {
    const table = new ReminderTable();
    table.add("Order bar oil", "nolan-voice");
    const { actions, app, sessionId } = await cancelApp(table);
    await utter(app, sessionId, { transcript: "Nolan cancel the bar oil reminder", isFinal: true });
    const cancelled = await utter(app, sessionId, { transcript: "Nolan cancel", isFinal: true });
    assert.equal(cancelled.json().dispatch.decision, "cancelled");
    const confirm = await utter(app, sessionId, { transcript: "Nolan confirm", isFinal: true });
    assert.equal(confirm.json().dispatch.decision, "confirmation-not-pending");
    assert.equal(actions.rows.size, 0);
    assert.equal(table.rows.length, 1);
  });

  it("stages a cancellation only on the voice project, never on a request-supplied target", async () => {
    const table = new ReminderTable();
    table.add("Order bar oil", "nolan-voice");
    const { actions, app, sessionId } = await cancelApp(table);
    await utter(app, sessionId, { transcript: "Nolan cancel the bar oil reminder", isFinal: true });
    const confirmed = await utter(app, sessionId, {
      transcript: "Nolan confirm",
      isFinal: true,
      ...TARGET,
    });
    assert.equal(confirmed.json().dispatch.toolActionId, undefined);
    assert.equal(confirmed.json().dispatch.reason, VOICE_COMPLETION_TARGET_REASON);
    assert.equal(actions.rows.size, 0);
  });
});
