import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import {
  deriveToolExecutionIdempotencyKey,
  ToolExecutionService,
} from "../src/actions/toolExecution.js";
import type { ToolAction, ToolActionService } from "../src/actions/toolActions.js";
import {
  createReminderToolDefinition,
  createTaskToolDefinition,
} from "../src/actions/taskReminderTools.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { ErrandStore } from "../src/errands/errand.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import type { ControlledReminderRecord } from "../src/reminders/controlledReminder.js";
import { captureCredentials, type CredentialsRuntime } from "../src/settings/credentialsStatus.js";
import type { ControlledTaskRecord } from "../src/tasks/controlledTask.js";

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

  async create(input: { projectId: string; title: string }): Promise<ControlledReminderRecord> {
    const record: ControlledReminderRecord = {
      id: `reminder-${this.records.length + 1}`,
      projectId: input.projectId,
      title: input.title,
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
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: persistence(),
    providerName: "json",
    config: CONFIG,
    credentialsRuntime: credentials("10.0.0.5"),
    logger: false,
    ...(actions ? { toolActionService: actions } : {}),
    ...(errandStore ? { errandStore } : {}),
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

  it("does not write an errand, because no ToolAction executor exists", async () => {
    const actions = new MemoryActions();
    let errandWrites = 0;
    const errandStore: ErrandStore = {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      add: () => {
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
});
