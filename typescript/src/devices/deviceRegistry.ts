import { z } from "zod";

import { canonicalJson } from "../actions/canonicalJson.js";
import {
  ANNOUNCEMENT_EXECUTION_TIMEOUT_MS,
  homeAnnouncementArgumentsSchema,
} from "../actions/homeAnnouncementTool.js";
import {
  ToolExecutionPreconditionError,
  type ToolExecutionContext,
  type ToolExecutionDefinition,
} from "../actions/toolExecution.js";
import type { ToolAuthority } from "../runtime/totalityPolicy.js";

/**
 * NOLAN device registry (#836), first slice.
 *
 * A pure, deny-by-default registry of versioned device bindings. It resolves
 * devices read-only and checks every request before any transport adapter is
 * called. It never approves anything: an effect is reachable only as a
 * `ToolExecutionDefinition` run by the existing `ToolExecutionService`, which
 * owns the claim, receipt and reconciliation. This module only verifies that
 * the approved ToolAction is bound to the exact device, binding version and
 * parameters. Nothing here is wired into production yet.
 */

/** The ToolAction `tool` for device effects; the operation is the capability. */
export const DEVICE_TOOL = "device";
export const DEVICE_EXTERNAL_PROVIDER = "nolan-device-registry-v1";

/** Closed set. Home Assistant and Grid Connect are future, separately reviewed adapters. */
export const DEVICE_ADAPTERS = ["google_cast_local"] as const;
export type DeviceAdapterKind = (typeof DEVICE_ADAPTERS)[number];

const emptyParams = z.object({}).strict();

/**
 * Closed capability set. Each capability has a strict parameter schema and is
 * either read-only or an effect. There is no generic shell, service-call or
 * network passthrough capability, and none can be added by a binding.
 */
export const DEVICE_CAPABILITY_SPECS = Object.freeze({
  read_state: Object.freeze({ effect: false, params: emptyParams }),
  announce: Object.freeze({
    effect: true,
    // Same bounds as the existing home announcement tool; the target comes
    // from the binding, never from the request.
    params: homeAnnouncementArgumentsSchema.omit({ target: true }).strict(),
  }),
});
export type DeviceCapability = keyof typeof DEVICE_CAPABILITY_SPECS;
export type DeviceEffectCapability = {
  [K in DeviceCapability]: (typeof DEVICE_CAPABILITY_SPECS)[K]["effect"] extends true ? K : never;
}[DeviceCapability];
export const DEVICE_CAPABILITIES = Object.freeze(
  Object.keys(DEVICE_CAPABILITY_SPECS) as DeviceCapability[],
);

function isCapability(value: string): value is DeviceCapability {
  return Object.prototype.hasOwnProperty.call(DEVICE_CAPABILITY_SPECS, value);
}

function isEffect(capability: DeviceCapability): boolean {
  return DEVICE_CAPABILITY_SPECS[capability].effect;
}

/** Stable NOLAN identifier, e.g. `nolan:device:kitchen-display`. */
export const deviceIdSchema = z
  .string()
  .regex(
    /^nolan:device:[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Device IDs look like nolan:device:kitchen-display.",
  )
  .max(100);

const nonEmpty = z.string().trim().min(1);
const isoTimestamp = z
  .string()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)) && /T/.test(value),
    "Expected an ISO timestamp.",
  );

export const deviceBindingSchema = z
  .object({
    deviceId: deviceIdSchema,
    /** Bumped on every change, so an approval for an older binding no longer matches. */
    bindingVersion: z.number().int().positive(),
    displayName: nonEmpty.max(120),
    adapter: z.enum(DEVICE_ADAPTERS),
    /** Adapter-specific target (for Cast, the allowlisted target name). Opaque here. */
    transportRef: nonEmpty.max(200),
    enabled: z.boolean(),
    capabilities: z
      .array(z.enum(DEVICE_CAPABILITIES as [DeviceCapability, ...DeviceCapability[]]))
      .min(1)
      .refine((list) => new Set(list).size === list.length, "Capabilities must not repeat."),
    risk: z.enum(["low", "medium", "high"]),
    enrolment: z
      .object({
        enrolledBy: z.literal("owner"),
        enrolledAt: isoTimestamp,
        /** Commissioning or owner-decision evidence for this enrolment. */
        evidenceRef: nonEmpty.max(200),
      })
      .strict(),
  })
  .strict();
export type DeviceBinding = z.infer<typeof deviceBindingSchema>;

export class DeviceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceRegistryError";
  }
}

export type DeviceRefusalReason =
  | "invalid_request"
  | "unknown_device"
  | "binding_disabled"
  | "binding_version_mismatch"
  | "unsupported_capability"
  | "invalid_parameters"
  | "adapter_unavailable"
  | "approval_required";

export type DeviceRefusal = { ok: false; reason: DeviceRefusalReason; message: string };

export type DeviceSummary = Readonly<{
  deviceId: string;
  bindingVersion: number;
  displayName: string;
  adapter: DeviceAdapterKind;
  enabled: boolean;
  capabilities: readonly DeviceCapability[];
  effectCapabilities: readonly DeviceCapability[];
  risk: DeviceBinding["risk"];
}>;

export type DeviceResolution = { ok: true; device: DeviceSummary } | DeviceRefusal;

export type AuthorizedDeviceRequest = {
  ok: true;
  binding: DeviceBinding;
  capability: DeviceCapability;
  params: Record<string, unknown>;
};

const deviceRequestSchema = z
  .object({
    deviceId: z.string(),
    bindingVersion: z.number().int().positive(),
    capability: z.string(),
    params: z.unknown(),
  })
  .strict();

function refuse(reason: DeviceRefusalReason, message: string): DeviceRefusal {
  return { ok: false, reason, message };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export class DeviceRegistry {
  private constructor(private readonly bindings: ReadonlyMap<string, DeviceBinding>) {}

  /** Validates every binding; any invalid or duplicate entry rejects the whole set. */
  static fromBindings(input: readonly unknown[]): DeviceRegistry {
    if (!Array.isArray(input)) throw new DeviceRegistryError("Device bindings must be an array.");
    const bindings = new Map<string, DeviceBinding>();
    input.forEach((raw, index) => {
      const parsed = deviceBindingSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(binding)"}: ${issue.message}`)
          .join("; ");
        throw new DeviceRegistryError(`Invalid device binding at index ${index}: ${issues}`);
      }
      if (bindings.has(parsed.data.deviceId)) {
        throw new DeviceRegistryError(`Duplicate device ID: ${parsed.data.deviceId}.`);
      }
      bindings.set(parsed.data.deviceId, deepFreeze(structuredClone(parsed.data)));
    });
    return new DeviceRegistry(bindings);
  }

  list(): readonly DeviceBinding[] {
    return [...this.bindings.values()].sort((a, b) =>
      a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0,
    );
  }

  /** Read-only resolution. Never calls a transport. */
  resolve(deviceId: unknown): DeviceResolution {
    const id = deviceIdSchema.safeParse(deviceId);
    if (!id.success) return refuse("invalid_request", "Device ID is malformed.");
    const found = this.bindings.get(id.data);
    if (!found) return refuse("unknown_device", "No device is enrolled with that ID.");
    return {
      ok: true,
      device: deepFreeze({
        deviceId: found.deviceId,
        bindingVersion: found.bindingVersion,
        displayName: found.displayName,
        adapter: found.adapter,
        enabled: found.enabled,
        capabilities: [...found.capabilities],
        effectCapabilities: found.capabilities.filter(isEffect),
        risk: found.risk,
      }),
    };
  }

  /**
   * Checks, in order: request shape, device known, binding enabled, binding
   * version, capability in the closed set and declared by the binding, and
   * parameters valid. Pure: it never calls a transport and never approves.
   */
  check(request: unknown): AuthorizedDeviceRequest | DeviceRefusal {
    const parsed = deviceRequestSchema.safeParse(request);
    if (!parsed.success) return refuse("invalid_request", "Device request is malformed.");
    const resolution = this.resolve(parsed.data.deviceId);
    if (!resolution.ok) return resolution;
    const found = this.bindings.get(resolution.device.deviceId)!;
    if (!found.enabled) return refuse("binding_disabled", "This device binding is disabled.");
    if (parsed.data.bindingVersion !== found.bindingVersion) {
      return refuse(
        "binding_version_mismatch",
        `Binding version ${parsed.data.bindingVersion} does not match the enrolled version ${found.bindingVersion}.`,
      );
    }
    const capability = parsed.data.capability;
    if (!isCapability(capability) || !found.capabilities.includes(capability)) {
      return refuse("unsupported_capability", "This device does not support that capability.");
    }
    const params = DEVICE_CAPABILITY_SPECS[capability].params.safeParse(parsed.data.params);
    if (!params.success) {
      return refuse("invalid_parameters", "Parameters are not valid for this capability.");
    }
    return { ok: true, binding: found, capability, params: params.data };
  }
}

export type DeviceAdapterAttempt = { providerRequestId: string; providerCorrelationId: string };

/**
 * Typed transport. Adapters receive only a validated binding, a closed-set
 * capability and parsed parameters. They never decide approval.
 */
export interface DeviceTransportAdapter {
  readonly kind: DeviceAdapterKind;
  readonly providerName: string;
  /** Capabilities this adapter can serve. A binding cannot widen it. */
  readonly supports: readonly DeviceCapability[];
  read(
    binding: DeviceBinding,
    capability: DeviceCapability,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  /** Resolves the exact target and an attempt identity before any effect. */
  prepareEffect(
    binding: DeviceBinding,
    capability: DeviceCapability,
    params: Record<string, unknown>,
  ): Promise<DeviceAdapterAttempt>;
  executeEffect(
    attempt: DeviceAdapterAttempt,
    binding: DeviceBinding,
    capability: DeviceCapability,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** One adapter per kind: an ambiguous set is refused rather than resolved by order. */
function assertUniqueAdapters(adapters: readonly DeviceTransportAdapter[]): void {
  const kinds = adapters.map((adapter) => adapter.kind);
  if (new Set(kinds).size !== kinds.length) {
    throw new DeviceRegistryError("Only one transport adapter may be registered per adapter kind.");
  }
}

function adapterFor(
  adapters: readonly DeviceTransportAdapter[],
  kind: DeviceAdapterKind,
): DeviceTransportAdapter | undefined {
  return adapters.find((adapter) => adapter.kind === kind);
}

export type DeviceReadOutcome = { ok: true; result: unknown } | DeviceRefusal;

/** Read-only capabilities only. Effects are refused here: they need the governed path. */
export async function readDevice(input: {
  registry: DeviceRegistry;
  adapters: readonly DeviceTransportAdapter[];
  request: unknown;
  signal: AbortSignal;
}): Promise<DeviceReadOutcome> {
  assertUniqueAdapters(input.adapters);
  const checked = input.registry.check(input.request);
  if (!checked.ok) return checked;
  if (isEffect(checked.capability)) {
    return refuse(
      "approval_required",
      "Effects run only through an approved ToolAction on the governed execution path.",
    );
  }
  const adapter = adapterFor(input.adapters, checked.binding.adapter);
  if (!adapter)
    return refuse("adapter_unavailable", "No transport adapter is registered for this device.");
  if (!adapter.supports.includes(checked.capability)) {
    return refuse(
      "unsupported_capability",
      "This device's adapter does not support that capability.",
    );
  }
  return {
    ok: true,
    result: await adapter.read(checked.binding, checked.capability, checked.params, input.signal),
  };
}

export const deviceEffectArgumentsSchema = z
  .object({
    deviceId: z.string(),
    bindingVersion: z.number().int().positive(),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();

const AUTHORITY_RANK = { T0: 0, T1: 1, T2: 2, T3: 3 } as const;

/** Riskier devices need a stronger approval tier; the binding's risk sets the floor. */
export const RISK_MINIMUM_AUTHORITY = Object.freeze({
  low: "T1",
  medium: "T2",
  high: "T3",
} as const satisfies Record<DeviceBinding["risk"], ToolAuthority>);

function precondition(message: string): never {
  throw new ToolExecutionPreconditionError(message);
}

/**
 * Verifies, never grants: the action must be a live user approval for this
 * exact tool, capability, device, binding version and parameters.
 */
function assertApprovedFor(
  context: ToolExecutionContext,
  capability: DeviceCapability,
  argumentsValue: Record<string, unknown>,
  now: () => number,
): void {
  const action = context.action;
  if (action.state !== "approved" || action.approvedBy !== "user") {
    precondition("Device effects need a ToolAction approved by the user.");
  }
  if (
    action.isApprovalExpired === true ||
    (action.approvalExpiresAt !== undefined && !(Date.parse(action.approvalExpiresAt) > now()))
  ) {
    precondition("The device-effect approval has expired.");
  }
  if (action.tool !== DEVICE_TOOL || action.operation !== capability) {
    precondition("The approval is for a different tool or capability.");
  }
  if (canonicalJson(action.arguments) !== canonicalJson(argumentsValue)) {
    precondition("The approval is bound to a different device, binding version or parameters.");
  }
}

function checkedEffect(
  registry: DeviceRegistry,
  capability: DeviceCapability,
  argumentsValue: Record<string, unknown>,
): AuthorizedDeviceRequest {
  const args = deviceEffectArgumentsSchema.safeParse(argumentsValue);
  if (!args.success) precondition("Device effect arguments are malformed.");
  const checked = registry.check({ ...args.data, capability });
  if (!checked.ok) precondition(`Device effect refused (${checked.reason}): ${checked.message}`);
  return checked;
}

/**
 * The only way to reach a device effect: a definition for the existing
 * `ToolExecutionService`. Registered only by `createDeviceToolDefinitionsFromEnv`.
 */
export function createDeviceEffectToolDefinition(input: {
  registry: DeviceRegistry;
  adapters: readonly DeviceTransportAdapter[];
  capability: DeviceEffectCapability;
  /** Clock for approval expiry; injectable for tests. */
  now?: () => number;
}): ToolExecutionDefinition {
  const { registry, adapters, capability } = input;
  const now = input.now ?? Date.now;
  assertUniqueAdapters(adapters);
  if (!isCapability(capability) || !isEffect(capability)) {
    throw new DeviceRegistryError("Only effect capabilities have a governed tool definition.");
  }
  const requireAdapter = (binding: DeviceBinding): DeviceTransportAdapter => {
    const adapter =
      adapterFor(adapters, binding.adapter) ??
      precondition("No transport adapter is registered for this device.");
    if (!adapter.supports.includes(capability)) {
      precondition("This device's adapter does not support that capability.");
    }
    return adapter;
  };

  return {
    tool: DEVICE_TOOL,
    operation: capability,
    externalProvider: DEVICE_EXTERNAL_PROVIDER,
    minimumAuthority: "T1",
    // A spoken announcement needs longer than the executor's 5 s default.
    ...(capability === "announce" ? { defaultTimeoutMs: ANNOUNCEMENT_EXECUTION_TIMEOUT_MS } : {}),
    schema: deviceEffectArgumentsSchema,
    // Runs before the single-use claim, so a refusal here spends no approval.
    async preflight(argumentsValue): Promise<void> {
      requireAdapter(checkedEffect(registry, capability, argumentsValue).binding);
    },
    async execute(argumentsValue, signal, context): Promise<unknown> {
      assertApprovedFor(context, capability, argumentsValue, now);
      // Re-check at execution time: the binding may have changed since approval.
      const checked = checkedEffect(registry, capability, argumentsValue);
      const floor = RISK_MINIMUM_AUTHORITY[checked.binding.risk];
      if (AUTHORITY_RANK[context.action.requiredAuthority] < AUTHORITY_RANK[floor]) {
        precondition(
          `A ${checked.binding.risk}-risk device needs an approval of at least ${floor}.`,
        );
      }
      const adapter = requireAdapter(checked.binding);
      const attempt = await adapter.prepareEffect(
        checked.binding,
        checked.capability,
        checked.params,
      );
      await context.registerProviderAttempt({
        provider: adapter.providerName,
        providerRequestId: attempt.providerRequestId,
        providerCorrelationId: attempt.providerCorrelationId,
      });
      return adapter.executeEffect(
        attempt,
        checked.binding,
        checked.capability,
        checked.params,
        signal,
      );
    },
  };
}
