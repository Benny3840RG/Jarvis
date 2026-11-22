import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolAction } from "../src/actions/toolActions.js";
import {
  ToolExecutionPreconditionError,
  type ToolExecutionContext,
} from "../src/actions/toolExecution.js";
import {
  DEVICE_TOOL,
  DeviceRegistry,
  DeviceRegistryError,
  createDeviceEffectToolDefinition,
  readDevice,
  type DeviceBinding,
  type DeviceTransportAdapter,
} from "../src/devices/deviceRegistry.js";

const KITCHEN = "nolan:device:kitchen-display";
const OFFICE = "nolan:device:office-speaker";

function binding(overrides: Partial<DeviceBinding> = {}): DeviceBinding {
  return {
    deviceId: KITCHEN,
    bindingVersion: 2,
    displayName: "Kitchen display",
    adapter: "google_cast_local",
    transportRef: "Kitchen display",
    enabled: true,
    capabilities: ["read_state", "announce"],
    risk: "low",
    enrolment: {
      enrolledBy: "owner",
      enrolledAt: "2026-11-19T00:00:00.000Z",
      evidenceRef: "commissioning-fixture-1",
    },
    ...overrides,
  };
}

type Call = { method: string; deviceId: string; capability?: string };

function mockAdapter(calls: Call[]): DeviceTransportAdapter {
  return {
    kind: "google_cast_local",
    providerName: "mock-cast",
    supports: ["read_state", "announce"],
    async read(device, capability) {
      calls.push({ method: "read", deviceId: device.deviceId, capability });
      return { state: "idle" };
    },
    async prepareEffect(device, capability) {
      calls.push({ method: "prepare", deviceId: device.deviceId, capability });
      return { providerRequestId: "attempt-1", providerCorrelationId: "corr-1" };
    },
    async executeEffect(_attempt, device, capability) {
      calls.push({ method: "execute", deviceId: device.deviceId, capability });
      return { result: "announced" };
    },
  };
}

function registry(...bindings: unknown[]): DeviceRegistry {
  return DeviceRegistry.fromBindings(bindings.length > 0 ? bindings : [binding()]);
}

const signal = new AbortController().signal;

describe("device registry construction", () => {
  it("accepts strict, versioned bindings and never mutates its input", () => {
    const input = [binding(), binding({ deviceId: OFFICE, displayName: "Office speaker" })];
    const snapshot = structuredClone(input);
    const devices = DeviceRegistry.fromBindings(input);
    assert.deepEqual(input, snapshot);
    assert.deepEqual(
      devices.list().map((device) => device.deviceId),
      [KITCHEN, OFFICE],
    );
  });

  it("rejects duplicate device IDs instead of letting order pick one", () => {
    assert.throws(
      () => DeviceRegistry.fromBindings([binding(), binding({ bindingVersion: 3 })]),
      (error: unknown) =>
        error instanceof DeviceRegistryError && /Duplicate device ID/.test(error.message),
    );
  });

  it("rejects malformed bindings: bad ID, unknown adapter, capability or field, repeats", () => {
    const bad: unknown[] = [
      binding({ deviceId: "kitchen" }),
      { ...binding(), adapter: "home_assistant" },
      { ...binding(), capabilities: ["shell"] },
      { ...binding(), capabilities: ["announce", "announce"] },
      { ...binding(), capabilities: [] },
      { ...binding(), bindingVersion: 0 },
      { ...binding(), haService: "light.turn_on" },
      { ...binding(), enrolment: { ...binding().enrolment, enrolledBy: "agent" } },
    ];
    for (const entry of bad) {
      assert.throws(() => DeviceRegistry.fromBindings([entry]), DeviceRegistryError);
    }
  });

  it("returns frozen views so callers cannot widen a binding after validation", () => {
    const devices = registry();
    const listed = devices.list()[0]!;
    assert.ok(Object.isFrozen(listed));
    assert.ok(Object.isFrozen(listed.capabilities));
  });
});

describe("read-only resolution", () => {
  it("resolves a known device without touching any transport", () => {
    const resolution = registry().resolve(KITCHEN);
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;
    assert.equal(resolution.device.bindingVersion, 2);
    assert.deepEqual(resolution.device.capabilities, ["read_state", "announce"]);
    assert.deepEqual(resolution.device.effectCapabilities, ["announce"]);
  });

  it("rejects unknown and malformed device IDs", () => {
    assert.deepEqual(registry().resolve(OFFICE), {
      ok: false,
      reason: "unknown_device",
      message: "No device is enrolled with that ID.",
    });
    const malformed = registry().resolve("../../etc/passwd");
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.reason, "invalid_request");
  });
});

describe("fail-closed read path", () => {
  const request = { deviceId: KITCHEN, bindingVersion: 2, capability: "read_state", params: {} };

  it("reads state through the adapter once checks pass", async () => {
    const calls: Call[] = [];
    const outcome = await readDevice({
      registry: registry(),
      adapters: [mockAdapter(calls)],
      request,
      signal,
    });
    assert.deepEqual(outcome, { ok: true, result: { state: "idle" } });
    assert.deepEqual(calls, [{ method: "read", deviceId: KITCHEN, capability: "read_state" }]);
  });

  const denials: Array<[string, unknown, DeviceRegistry, string]> = [
    ["unknown device", { ...request, deviceId: OFFICE }, registry(), "unknown_device"],
    ["disabled binding", request, registry(binding({ enabled: false })), "binding_disabled"],
    [
      "stale binding version",
      { ...request, bindingVersion: 1 },
      registry(),
      "binding_version_mismatch",
    ],
    [
      "capability the binding does not declare",
      request,
      registry(binding({ capabilities: ["announce"] })),
      "unsupported_capability",
    ],
    [
      "capability outside the closed set",
      { ...request, capability: "shell" },
      registry(),
      "unsupported_capability",
    ],
    [
      "malformed parameters",
      { ...request, params: { path: "/" } },
      registry(),
      "invalid_parameters",
    ],
    ["malformed request", { ...request, extra: true }, registry(), "invalid_request"],
    [
      "effect through the read path",
      { ...request, capability: "announce", params: { message: "hello" } },
      registry(),
      "approval_required",
    ],
  ];

  for (const [name, input, devices, reason] of denials) {
    it(`refuses ${name} with zero transport calls`, async () => {
      const calls: Call[] = [];
      const outcome = await readDevice({
        registry: devices,
        adapters: [mockAdapter(calls)],
        request: input,
        signal,
      });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.reason, reason);
      assert.deepEqual(calls, []);
    });
  }

  it("refuses when no adapter is registered for the binding", async () => {
    const outcome = await readDevice({ registry: registry(), adapters: [], request, signal });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "adapter_unavailable");
  });
});

function approvedAction(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    baseRevision: 1,
    state: "approved",
    tool: DEVICE_TOOL,
    operation: "announce",
    arguments: { deviceId: KITCHEN, bindingVersion: 2, params: { message: "Dinner is ready" } },
    rationale: "owner asked for an announcement",
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: "idem-1",
    proposedBy: "user",
    approvedBy: "user",
    consumptionPolicy: "single-use",
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    ...overrides,
  };
}

function context(action: ToolAction, order: string[]): ToolExecutionContext {
  return {
    action,
    idempotencyKey: "idem-1",
    actionFingerprint: "action-fp",
    effectFingerprint: "effect-fp",
    correlationId: "corr-1",
    source: "test",
    policyVersion: "test",
    async registerProviderAttempt(): Promise<void> {
      order.push("register");
    },
  };
}

describe("governed effect path", () => {
  const args = { deviceId: KITCHEN, bindingVersion: 2, params: { message: "Dinner is ready" } };

  function definition(calls: Call[], devices = registry()) {
    return createDeviceEffectToolDefinition({
      registry: devices,
      adapters: [mockAdapter(calls)],
      capability: "announce",
    });
  }

  it("is a ToolExecutionDefinition owned by the existing governance boundary", () => {
    const tool = definition([]);
    assert.equal(tool.tool, DEVICE_TOOL);
    assert.equal(tool.operation, "announce");
    assert.equal(tool.minimumAuthority, "T1");
    assert.equal(typeof tool.externalProvider, "string");
    // An announcement needs longer than the executor's 5 s default (#697 B2).
    assert.equal(tool.defaultTimeoutMs, 30_000);
    assert.equal(tool.schema.safeParse({ ...args, shell: "rm -rf /" }).success, false);
  });

  it("refuses to build a definition for a read-only capability", () => {
    assert.throws(
      () =>
        createDeviceEffectToolDefinition({
          registry: registry(),
          adapters: [],
          capability: "read_state" as "announce",
        }),
      DeviceRegistryError,
    );
  });

  it("registers the provider attempt before the effect when the approval matches", async () => {
    const calls: Call[] = [];
    const order: string[] = [];
    const tool = definition(calls);
    await tool.preflight?.(args, signal);
    const result = await tool.execute(args, signal, {
      ...context(approvedAction(), order),
      async registerProviderAttempt() {
        order.push(`register after ${calls.map((call) => call.method).join(",")}`);
      },
    });
    assert.deepEqual(result, { result: "announced" });
    assert.deepEqual(
      calls.map((call) => call.method),
      ["prepare", "execute"],
    );
    assert.deepEqual(order, ["register after prepare"]);
  });

  it("preflight refuses unknown, disabled, stale and malformed requests before any claim", async () => {
    const cases: Array<[Record<string, unknown>, DeviceRegistry]> = [
      [{ ...args, deviceId: OFFICE }, registry()],
      [args, registry(binding({ enabled: false }))],
      [{ ...args, bindingVersion: 1 }, registry()],
      [{ ...args, params: { message: "" } }, registry()],
      [{ ...args, params: { message: "hi", volume: 1 } }, registry()],
      [args, registry(binding({ capabilities: ["read_state"] }))],
    ];
    for (const [input, devices] of cases) {
      const calls: Call[] = [];
      await assert.rejects(
        () => definition(calls, devices).preflight!(input, signal),
        ToolExecutionPreconditionError,
      );
      assert.deepEqual(calls, []);
    }
  });

  const unapproved: Array<[string, ToolAction]> = [
    ["a proposed action", approvedAction({ state: "proposed", approvedBy: undefined })],
    ["a revoked action", approvedAction({ state: "revoked" })],
    ["an expired approval", approvedAction({ isApprovalExpired: true })],
    ["an approval not given by the user", approvedAction({ approvedBy: undefined })],
    ["an action for another tool", approvedAction({ tool: "home" })],
    ["an action for another operation", approvedAction({ operation: "read_state" })],
    [
      "an approval bound to different parameters",
      approvedAction({
        arguments: { ...args, params: { message: "Something else" } },
      }),
    ],
    [
      "an approval bound to another binding version",
      approvedAction({ arguments: { ...args, bindingVersion: 1 } }),
    ],
  ];

  for (const [name, action] of unapproved) {
    it(`refuses ${name} with zero transport calls`, async () => {
      const calls: Call[] = [];
      const order: string[] = [];
      await assert.rejects(
        () => definition(calls).execute(args, signal, context(action, order)),
        ToolExecutionPreconditionError,
      );
      assert.deepEqual(calls, []);
      assert.deepEqual(order, []);
    });
  }

  it("re-checks the binding at execution time, after approval", async () => {
    const calls: Call[] = [];
    const tool = definition(calls, registry(binding({ bindingVersion: 3 })));
    await assert.rejects(
      () => tool.execute(args, signal, context(approvedAction(), [])),
      ToolExecutionPreconditionError,
    );
    assert.deepEqual(calls, []);
  });

  it("refuses an approval whose expiry time has passed, even if not yet marked expired", async () => {
    const calls: Call[] = [];
    const tool = createDeviceEffectToolDefinition({
      registry: registry(),
      adapters: [mockAdapter(calls)],
      capability: "announce",
      now: () => Date.parse("2026-11-19T12:00:00.000Z"),
    });
    const action = approvedAction({ approvalExpiresAt: "2026-11-19T11:59:59.000Z" });
    await assert.rejects(() => tool.execute(args, signal, context(action, [])), /expired/);
    assert.deepEqual(calls, []);
  });

  it("requires a stronger approval tier for riskier devices", async () => {
    for (const [risk, authority, allowed] of [
      ["medium", "T1", false],
      ["medium", "T2", true],
      ["high", "T2", false],
      ["high", "T3", true],
    ] as const) {
      const calls: Call[] = [];
      const tool = definition(calls, registry(binding({ risk })));
      const run = tool.execute(
        args,
        signal,
        context(approvedAction({ requiredAuthority: authority }), []),
      );
      if (allowed) {
        await run;
        assert.equal(calls.length, 2);
      } else {
        await assert.rejects(() => run, /needs an approval of at least/);
        assert.deepEqual(calls, []);
      }
    }
  });
});

describe("registry inputs fail closed", () => {
  it("refuses an ambiguous adapter set instead of picking one by order", async () => {
    const adapters = [mockAdapter([]), mockAdapter([])];
    await assert.rejects(
      () =>
        readDevice({
          registry: registry(),
          adapters,
          request: { deviceId: KITCHEN, bindingVersion: 2, capability: "read_state", params: {} },
          signal,
        }),
      DeviceRegistryError,
    );
    assert.throws(
      () =>
        createDeviceEffectToolDefinition({
          registry: registry(),
          adapters,
          capability: "announce",
        }),
      DeviceRegistryError,
    );
  });

  it("rejects a non-array binding set with a clear error", () => {
    assert.throws(
      () => DeviceRegistry.fromBindings({ length: 1 } as unknown as unknown[]),
      /must be an array/,
    );
  });
});
