import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import vm from "node:vm";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createErrandToolDefinitions } from "../src/actions/errandTools.js";
import { ToolExecutionService } from "../src/actions/toolExecution.js";
import type { ToolAction, ToolActionService, ToolActionState } from "../src/actions/toolActions.js";
import { InMemoryErrandStore } from "../src/errands/inMemoryErrandStore.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { captureCredentials } from "../src/settings/credentialsStatus.js";

const SERVICE = "approvals-service-token";
const APPROVAL = "approvals-approval-token";

const openApps: NestFastifyApplication[] = [];
afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
});

class Actions implements ToolActionService {
  readonly rows = new Map<string, ToolAction>();
  rejected: string[] = [];

  async stage(input: Parameters<ToolActionService["stage"]>[0]): Promise<ToolAction> {
    const row: ToolAction = {
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
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
    };
    this.rows.set(row.actionId, row);
    return row;
  }

  async get(input: { actionId: string; projectId: string }): Promise<ToolAction | null> {
    const row = this.rows.get(input.actionId);
    return row && row.projectId === input.projectId ? row : null;
  }

  async list(input: { projectId: string; state?: ToolActionState }): Promise<ToolAction[]> {
    return [...this.rows.values()].filter(
      (row) =>
        row.projectId === input.projectId &&
        (input.state === undefined || row.state === input.state),
    );
  }

  async approve(input: {
    actionId: string;
    projectId: string;
    expectedRevision: number;
  }): Promise<ToolAction> {
    const row = await this.get(input);
    if (!row) throw new Error("Tool action does not exist.");
    if (row.baseRevision !== input.expectedRevision) {
      throw new Error("Project revision conflict.");
    }
    const approved: ToolAction = { ...row, state: "approved", approvedBy: "user" };
    this.rows.set(row.actionId, approved);
    return approved;
  }

  async reject(input: {
    actionId: string;
    projectId: string;
    reason: string;
  }): Promise<ToolAction> {
    const row = await this.get(input);
    if (!row) throw new Error("Tool action does not exist.");
    this.rejected.push(input.reason);
    const rejected: ToolAction = { ...row, state: "rejected", rejectedReason: input.reason };
    this.rows.set(row.actionId, rejected);
    return rejected;
  }
}

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("approvals page tests do not touch the task or reminder list");
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

async function open(host = "127.0.0.1") {
  const config: HttpAppConfig = {
    version: "0.1.0",
    sourceVersion: "approvals-page-test",
    deploymentVersion: null,
    timezone: "Australia/Melbourne",
    currentToken: SERVICE,
    previousToken: undefined,
    currentApprovalToken: APPROVAL,
  };
  const actions = new Actions();
  const errands = new InMemoryErrandStore();
  const app = await createJarvisHttpApp({
    config,
    credentialsRuntime: captureCredentials({
      serviceToken: SERVICE,
      httpHost: host,
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    }),
    persistence: unusedPersistence(),
    providerName: "json",
    logger: false,
    toolActionService: actions,
    toolExecutionService: new ToolExecutionService(createErrandToolDefinitions(errands)),
    errandStore: errands,
  });
  openApps.push(app);
  return { app, actions, errands };
}

// ---- a minimal DOM: just enough for the page script, all text via textContent ----

class FakeNode {
  readonly children: FakeNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, Array<() => unknown>>();
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  type = "";
  value = "";
  constructor(readonly tagName: string) {}
  append(...nodes: FakeNode[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children.length = 0;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(event: string, listener: () => unknown) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        if (child.tagName === selector) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  async click() {
    for (const listener of this.listeners.get("click") ?? []) await listener();
  }
  text(): string {
    return [this.textContent, ...this.children.map((child) => child.text())]
      .filter(Boolean)
      .join(" ");
  }
}

async function page(app: NestFastifyApplication) {
  const html = (await app.inject({ method: "GET", url: "/settings/approvals" })).body;
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script, "the page carries its script inline");
  const elements = new Map<string, FakeNode>();
  for (const id of [
    "service-token",
    "approval-token",
    "project-key",
    "banner",
    "load",
    "loaded",
    "proposed",
    "approved",
  ]) {
    elements.set(id, new FakeNode(id === "load" ? "button" : "div"));
  }
  (elements.get("project-key") as FakeNode).value = "nolan-voice";
  const requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  }> = [];
  const context = {
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: (tag: string) => new FakeNode(tag),
    },
    window: { addEventListener: () => undefined },
    fetch: async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      requests.push({ method: init.method, url, headers: init.headers, body });
      const response = await app.inject({
        method: init.method as "GET" | "POST",
        url,
        headers: init.headers,
        ...(init.body === undefined ? {} : { payload: init.body }),
      });
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: async () => JSON.parse(response.body),
      };
    },
    Promise,
    JSON,
    Error,
    String,
    Array,
    Date,
    encodeURIComponent,
  };
  vm.runInNewContext(script, context);
  const byId = (id: string) => elements.get(id) as FakeNode;
  const buttons = (container: string) => byId(container).querySelectorAll("button");
  return { byId, buttons, requests };
}

async function stageErrand(actions: Actions, title: string, actionId: string) {
  await actions.stage({
    actionId,
    requestId: actionId,
    projectId: "nolan-voice",
    expectedRevision: 3,
    tool: "errands",
    operation: "create",
    arguments: { title },
    rationale: `Voice safe write client.capture-errand: Add errand “${title}”`,
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: actionId,
    proposedBy: "user",
  });
}

describe("approvals page HTTP posture", () => {
  it("serves a token-free shell on loopback with a strict CSP and no browser storage", async () => {
    const { app } = await open();
    const response = await app.inject({ method: "GET", url: "/settings/approvals" });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-security-policy"]), /default-src 'none'/);
    assert.match(String(response.headers["content-security-policy"]), /connect-src 'self'/);
    assert.equal(response.headers["cache-control"], "no-store");
    for (const forbidden of [SERVICE, APPROVAL, "localStorage", "sessionStorage", "innerHTML"]) {
      assert.equal(response.body.includes(forbidden), false, forbidden);
    }
  });

  it("is not served off loopback, and the tool-action routes still need the service token", async () => {
    const { app } = await open("0.0.0.0");
    assert.equal((await app.inject({ method: "GET", url: "/settings/approvals" })).statusCode, 404);
    const local = await open();
    const anonymous = await local.app.inject({
      method: "GET",
      url: "/api/v1/projects/nolan-voice/tool-actions?state=proposed",
    });
    assert.equal(anonymous.statusCode, 401, "the page adds no anonymous access to actions");
  });

  it("is linked from the HUD", async () => {
    const { app } = await open();
    const hud = await app.inject({ method: "GET", url: "/hud" });
    assert.match(hud.body, /href="\/settings\/approvals"/);
  });
});

describe("approvals page script against the real routes", () => {
  it("lists a staged change in plain words, then approves and runs it exactly once", async () => {
    const { app, actions, errands } = await open();
    await stageErrand(actions, "Milk", "voice-safe-write:v1:milk");
    const { byId, buttons, requests } = await page(app);

    byId("service-token").value = SERVICE;
    await byId("load").click();
    assert.equal(byId("banner").hidden, true, byId("banner").textContent);
    const proposed = byId("proposed").text();
    assert.match(proposed, /Add errand “Milk”/);
    assert.match(proposed, /errands:create/);
    assert.match(proposed, /\{"title":"Milk"\}/);

    // Approving needs the approval token; without it nothing is sent.
    const [approve] = buttons("proposed");
    assert.ok(approve);
    const before = requests.length;
    await approve.click();
    assert.equal(requests.length, before);
    assert.match(byId("proposed").text(), /Enter the service token and the approval token first/);
    assert.equal((await errands.list()).length, 0);

    byId("approval-token").value = APPROVAL;
    await approve.click();
    assert.match(byId("proposed").text(), /Done\. The change has been made\./);
    const approveCall = requests.find((request) => request.url.endsWith("/approve"));
    assert.deepEqual(approveCall?.body, { expectedRevision: 3, approvalToken: APPROVAL });
    assert.equal(approveCall?.headers.authorization, `Bearer ${SERVICE}`);
    assert.deepEqual(
      (await errands.list()).map((errand) => errand.title),
      ["Milk"],
    );

    // Reload: it is now approved; running it again changes nothing.
    await byId("load").click();
    assert.match(byId("proposed").text(), /Nothing is waiting for your approval/);
    const [run] = buttons("approved");
    assert.ok(run);
    await run.click();
    assert.match(byId("approved").text(), /Done\./);
    assert.equal((await errands.list()).length, 1, "a second run is a replay");
  });

  it("a wrong approval token is refused by the server and nothing runs", async () => {
    const { app, actions, errands } = await open();
    await stageErrand(actions, "Screws", "voice-safe-write:v1:screws");
    const { byId, buttons, requests } = await page(app);
    byId("service-token").value = SERVICE;
    byId("approval-token").value = "not-the-approval-token";
    await byId("load").click();
    const [approve] = buttons("proposed");
    await approve?.click();
    assert.match(byId("proposed").text(), /valid approval token is required/);
    assert.equal(
      requests.some((request) => request.url.endsWith("/execute")),
      false,
    );
    assert.equal(actions.rows.get("voice-safe-write:v1:screws")?.state, "proposed");
    assert.equal((await errands.list()).length, 0);
  });

  it("rejects without the approval token and changes nothing", async () => {
    const { app, actions, errands } = await open();
    await stageErrand(actions, "Bread", "voice-safe-write:v1:bread");
    const { byId, buttons } = await page(app);
    byId("service-token").value = SERVICE;
    await byId("load").click();
    const reject = buttons("proposed").find((button) => button.dataset.act === "reject");
    await reject?.click();
    assert.match(byId("proposed").text(), /Rejected\. Nothing was changed\./);
    assert.equal(actions.rows.get("voice-safe-write:v1:bread")?.state, "rejected");
    assert.equal((await errands.list()).length, 0);
  });

  it("explains a bad service token instead of showing an empty queue", async () => {
    const { app, actions } = await open();
    await stageErrand(actions, "Milk", "voice-safe-write:v1:milk");
    const { byId } = await page(app);
    await byId("load").click();
    assert.match(byId("banner").textContent, /Enter the service token/);
    byId("service-token").value = "wrong";
    await byId("load").click();
    assert.equal(byId("banner").hidden, false);
    assert.doesNotMatch(byId("proposed").text(), /Nothing is waiting/);
  });
});
