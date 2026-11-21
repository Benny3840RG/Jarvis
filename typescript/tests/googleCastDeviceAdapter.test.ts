import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolAction } from "../src/actions/toolActions.js";
import type { ToolExecutionContext } from "../src/actions/toolExecution.js";
import {
  DEVICE_TOOL,
  DeviceRegistry,
  DeviceRegistryError,
  createDeviceEffectToolDefinition,
  readDevice,
  type DeviceBinding,
} from "../src/devices/deviceRegistry.js";
import {
  DEVICE_BINDINGS_ENV,
  createDeviceToolDefinitionsFromEnv,
  createGoogleCastDeviceAdapter,
} from "../src/devices/googleCastDeviceAdapter.js";
import { createToolExecutionDefinitions } from "../src/actions/toolExecutionFactory.js";
import type {
  GoogleHomeAnnouncementInput,
  GoogleHomeAnnouncementProvider,
} from "../src/integrations/googleHome/googleHomeAnnouncementProvider.js";
import type { NoteStore } from "../src/notes/note.js";

const KITCHEN = "nolan:device:kitchen-display";

function binding(overrides: Partial<DeviceBinding> = {}): DeviceBinding {
  return {
    deviceId: KITCHEN,
    bindingVersion: 1,
    displayName: "Kitchen display",
    adapter: "google_cast_local",
    transportRef: "Kitchen display",
    enabled: true,
    capabilities: ["announce"],
    risk: "low",
    enrolment: {
      enrolledBy: "owner",
      enrolledAt: "2026-11-19T00:00:00.000Z",
      evidenceRef: "commissioning-fixture-1",
    },
    ...overrides,
  };
}

type Event = { method: string; input?: GoogleHomeAnnouncementInput };

function fakeProvider(events: Event[]): GoogleHomeAnnouncementProvider {
  let next = 0;
  return {
    name: "google-cast-local-v1",
    async discover() {
      return [];
    },
    async prepare(input) {
      events.push({ method: "prepare", input });
      next += 1;
      return {
        providerRequestId: `attempt-${next}`,
        providerCorrelationId: `corr-${next}`,
        target: input.target,
        address: "192.0.2.10",
      };
    },
    async sendPrepared(_attempt, input) {
      events.push({ method: "send", input });
      return { target: input.target, result: "announced" };
    },
  };
}

const signal = new AbortController().signal;
const params = { message: "Dinner is ready" };

describe("Google Cast device adapter", () => {
  it("announces to the binding's pinned target, never a request-supplied one", async () => {
    const events: Event[] = [];
    const adapter = createGoogleCastDeviceAdapter(fakeProvider(events));
    const attempt = await adapter.prepareEffect(binding(), "announce", params);
    await adapter.executeEffect(attempt, binding(), "announce", params, signal);
    assert.deepEqual(
      events.map((event) => [event.method, event.input?.target]),
      [
        ["prepare", "Kitchen display"],
        ["send", "Kitchen display"],
      ],
    );
  });

  it("refuses to send when execution does not match the prepared attempt", async () => {
    const mismatches: Array<
      [
        string,
        (attempt: {
          providerRequestId: string;
          providerCorrelationId: string;
        }) => Parameters<ReturnType<typeof createGoogleCastDeviceAdapter>["executeEffect"]>,
      ]
    > = [
      [
        "other parameters",
        (attempt) => [attempt, binding(), "announce", { message: "Other" }, signal],
      ],
      [
        "other binding version",
        (attempt) => [attempt, binding({ bindingVersion: 2 }), "announce", params, signal],
      ],
      [
        "other device",
        (attempt) => [
          attempt,
          binding({ deviceId: "nolan:device:office" }),
          "announce",
          params,
          signal,
        ],
      ],
      [
        "other target",
        (attempt) => [attempt, binding({ transportRef: "Office" }), "announce", params, signal],
      ],
      [
        "forged correlation",
        (attempt) => [
          { ...attempt, providerCorrelationId: "x" },
          binding(),
          "announce",
          params,
          signal,
        ],
      ],
    ];
    for (const [name, build] of mismatches) {
      const events: Event[] = [];
      const adapter = createGoogleCastDeviceAdapter(fakeProvider(events));
      const attempt = await adapter.prepareEffect(binding(), "announce", params);
      await assert.rejects(
        () => adapter.executeEffect(...build(attempt)),
        DeviceRegistryError,
        name,
      );
      assert.deepEqual(
        events.map((event) => event.method),
        ["prepare"],
        name,
      );
    }
  });

  it("uses each prepared attempt once", async () => {
    const events: Event[] = [];
    const adapter = createGoogleCastDeviceAdapter(fakeProvider(events));
    const attempt = await adapter.prepareEffect(binding(), "announce", params);
    await adapter.executeEffect(attempt, binding(), "announce", params, signal);
    await assert.rejects(
      () => adapter.executeEffect(attempt, binding(), "announce", params, signal),
      DeviceRegistryError,
    );
    assert.equal(events.filter((event) => event.method === "send").length, 1);
  });

  it("bounds abandoned attempts, evicting the oldest", async () => {
    const events: Event[] = [];
    const adapter = createGoogleCastDeviceAdapter(fakeProvider(events), 2);
    const first = await adapter.prepareEffect(binding(), "announce", params);
    await adapter.prepareEffect(binding(), "announce", params);
    await adapter.prepareEffect(binding(), "announce", params);
    await assert.rejects(
      () => adapter.executeEffect(first, binding(), "announce", params, signal),
      DeviceRegistryError,
    );
  });

  it("serves no read capability, so a read-state binding is refused before any call", async () => {
    const events: Event[] = [];
    const outcome = await readDevice({
      registry: DeviceRegistry.fromBindings([
        binding({ capabilities: ["read_state", "announce"] }),
      ]),
      adapters: [createGoogleCastDeviceAdapter(fakeProvider(events))],
      request: { deviceId: KITCHEN, bindingVersion: 1, capability: "read_state", params: {} },
      signal,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "unsupported_capability");
    assert.equal(events.length, 0);
  });
});

function approvedAction(): ToolAction {
  return {
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    baseRevision: 1,
    state: "approved",
    tool: DEVICE_TOOL,
    operation: "announce",
    arguments: { deviceId: KITCHEN, bindingVersion: 1, params },
    rationale: "owner asked for an announcement",
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: "idem-1",
    proposedBy: "user",
    approvedBy: "user",
    consumptionPolicy: "single-use",
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
  };
}

describe("governed device announce over Cast", () => {
  it("prepares, registers the attempt, then announces", async () => {
    const events: Event[] = [];
    const tool = createDeviceEffectToolDefinition({
      registry: DeviceRegistry.fromBindings([binding()]),
      adapters: [createGoogleCastDeviceAdapter(fakeProvider(events))],
      capability: "announce",
    });
    const order: string[] = [];
    const context: ToolExecutionContext = {
      action: approvedAction(),
      idempotencyKey: "idem-1",
      actionFingerprint: "action-fp",
      effectFingerprint: "effect-fp",
      correlationId: "corr-1",
      source: "test",
      policyVersion: "test",
      async registerProviderAttempt(reference) {
        order.push(`register ${reference.provider} ${reference.providerRequestId}`);
      },
    };
    const args = { deviceId: KITCHEN, bindingVersion: 1, params };
    await tool.preflight?.(args, signal);
    assert.equal(events.length, 0);
    await tool.execute(args, signal, {
      ...context,
      async registerProviderAttempt(reference) {
        order.push(`after ${events.map((event) => event.method).join(",")}`);
        await context.registerProviderAttempt(reference);
      },
    });
    assert.deepEqual(order, ["after prepare", "register google-cast-local-v1 attempt-1"]);
    assert.deepEqual(
      events.map((event) => event.method),
      ["prepare", "send"],
    );
  });
});

describe("dormant-first device wiring", () => {
  const pins = JSON.stringify({ "Kitchen display": "192.0.2.10" });
  const env = (bindings: unknown): NodeJS.ProcessEnv => ({
    JARVIS_GOOGLE_HOME_TARGETS_JSON: pins,
    [DEVICE_BINDINGS_ENV]: typeof bindings === "string" ? bindings : JSON.stringify(bindings),
  });

  it("registers nothing when bindings are not configured", () => {
    assert.deepEqual(createDeviceToolDefinitionsFromEnv(fakeProvider([]), {}), []);
    assert.deepEqual(
      createDeviceToolDefinitionsFromEnv(fakeProvider([]), { [DEVICE_BINDINGS_ENV]: "  " }),
      [],
    );
  });

  it("registers device:announce for valid bindings to pinned targets", () => {
    const tools = createDeviceToolDefinitionsFromEnv(fakeProvider([]), env([binding()]));
    assert.deepEqual(
      tools.map((tool) => `${tool.tool}:${tool.operation}`),
      ["device:announce"],
    );
  });

  it("refuses startup on invalid JSON, invalid bindings, a missing provider or an unpinned target", () => {
    assert.throws(
      () => createDeviceToolDefinitionsFromEnv(fakeProvider([]), env("{")),
      /valid JSON/,
    );
    assert.throws(
      () => createDeviceToolDefinitionsFromEnv(fakeProvider([]), env({ deviceId: KITCHEN })),
      /JSON array/,
    );
    assert.throws(
      () =>
        createDeviceToolDefinitionsFromEnv(fakeProvider([]), env([{ ...binding(), shell: "x" }])),
      DeviceRegistryError,
    );
    assert.throws(
      () => createDeviceToolDefinitionsFromEnv(undefined, env([binding()])),
      /no Google Cast/,
    );
    assert.throws(
      () =>
        createDeviceToolDefinitionsFromEnv(
          fakeProvider([]),
          env([binding({ transportRef: "Garage speaker" })]),
        ),
      /not pinned/,
    );
  });

  it("adds device tools to the registered tool set without touching home.announce", () => {
    const noteStore = {} as NoteStore;
    const provider = fakeProvider([]);
    const deviceTools = createDeviceToolDefinitionsFromEnv(provider, env([binding()]));
    const names = createToolExecutionDefinitions(
      noteStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      provider,
      undefined,
      { deviceTools },
    ).map((tool) => `${tool.tool}:${tool.operation}`);
    assert.ok(names.includes("home:announce"));
    assert.ok(names.includes("device:announce"));
    const without = createToolExecutionDefinitions(
      noteStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      provider,
    ).map((tool) => `${tool.tool}:${tool.operation}`);
    assert.ok(!without.includes("device:announce"));
  });
});
