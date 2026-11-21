import { canonicalJson } from "../actions/canonicalJson.js";
import type { ToolExecutionDefinition } from "../actions/toolExecution.js";
import {
  describeGoogleHomePins,
  type GoogleHomeAnnouncementAttempt,
  type GoogleHomeAnnouncementInput,
  type GoogleHomeAnnouncementProvider,
} from "../integrations/googleHome/googleHomeAnnouncementProvider.js";
import {
  DEVICE_CAPABILITY_SPECS,
  DeviceRegistry,
  DeviceRegistryError,
  createDeviceEffectToolDefinition,
  type DeviceTransportAdapter,
} from "./deviceRegistry.js";

/**
 * Device-registry adapter over the existing local Google Cast provider (#836).
 *
 * Announce only. The Cast target is the binding's `transportRef`, so the
 * provider's pinned-target allowlist still decides which address is reached;
 * a request can never name a target. Approval stays with the governed
 * execution path that calls this adapter.
 */
export const DEFAULT_MAX_PENDING_ATTEMPTS = 16;

type PendingAttempt = {
  attempt: GoogleHomeAnnouncementAttempt;
  input: GoogleHomeAnnouncementInput;
  deviceId: string;
  bindingVersion: number;
  paramsKey: string;
};

export function createGoogleCastDeviceAdapter(
  provider: GoogleHomeAnnouncementProvider,
  maxPending = DEFAULT_MAX_PENDING_ATTEMPTS,
): DeviceTransportAdapter {
  // Prepared attempts, oldest first. Bounded so an abandoned attempt cannot grow it.
  const pending = new Map<string, PendingAttempt>();

  return {
    kind: "google_cast_local",
    providerName: provider.name,
    supports: Object.freeze(["announce"] as const),
    async read(): Promise<unknown> {
      throw new DeviceRegistryError("The Google Cast adapter has no read-only capability.");
    },
    async prepareEffect(binding, capability, params) {
      if (capability !== "announce") {
        throw new DeviceRegistryError("The Google Cast adapter only announces.");
      }
      const parsed = DEVICE_CAPABILITY_SPECS.announce.params.parse(params);
      const input: GoogleHomeAnnouncementInput = {
        target: binding.transportRef,
        message: parsed.message,
        ...(parsed.volume === undefined ? {} : { volume: parsed.volume }),
      };
      const attempt = await provider.prepare(input);
      pending.set(attempt.providerRequestId, {
        attempt,
        input,
        deviceId: binding.deviceId,
        bindingVersion: binding.bindingVersion,
        paramsKey: canonicalJson(parsed),
      });
      while (pending.size > maxPending) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      return {
        providerRequestId: attempt.providerRequestId,
        providerCorrelationId: attempt.providerCorrelationId,
      };
    },
    async executeEffect(attempt, binding, capability, params, signal) {
      const entry = pending.get(attempt.providerRequestId);
      // Single use: an attempt is consumed whether or not it matches.
      pending.delete(attempt.providerRequestId);
      if (
        capability !== "announce" ||
        entry === undefined ||
        entry.attempt.providerCorrelationId !== attempt.providerCorrelationId ||
        entry.deviceId !== binding.deviceId ||
        entry.bindingVersion !== binding.bindingVersion ||
        entry.input.target !== binding.transportRef ||
        entry.paramsKey !== canonicalJson(DEVICE_CAPABILITY_SPECS.announce.params.parse(params))
      ) {
        throw new DeviceRegistryError("The announcement does not match a prepared attempt.");
      }
      return provider.sendPrepared(entry.attempt, entry.input, signal);
    },
  };
}

export const DEVICE_BINDINGS_ENV = "JARVIS_DEVICE_BINDINGS_JSON";

/**
 * Dormant-first wiring. Returns no tools unless `JARVIS_DEVICE_BINDINGS_JSON`
 * is set. When it is set, any problem refuses startup instead of loading a
 * partial registry: invalid JSON or bindings, no Cast provider, or a Cast
 * binding whose `transportRef` is not a pinned announcement target.
 */
export function createDeviceToolDefinitionsFromEnv(
  provider: GoogleHomeAnnouncementProvider | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ToolExecutionDefinition[] {
  const raw = env[DEVICE_BINDINGS_ENV]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeviceRegistryError(`${DEVICE_BINDINGS_ENV} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new DeviceRegistryError(`${DEVICE_BINDINGS_ENV} must be a JSON array of bindings.`);
  }
  const registry = DeviceRegistry.fromBindings(parsed);
  if (provider === undefined) {
    throw new DeviceRegistryError(
      `${DEVICE_BINDINGS_ENV} is set but no Google Cast announcement targets are configured.`,
    );
  }
  const pins = describeGoogleHomePins(env);
  const pinned = new Set(pins.status === "pinned" ? pins.targetNames : []);
  for (const binding of registry.list()) {
    if (binding.adapter === "google_cast_local" && !pinned.has(binding.transportRef)) {
      throw new DeviceRegistryError(
        `Device ${binding.deviceId} names a Cast target that is not pinned.`,
      );
    }
  }
  return [
    createDeviceEffectToolDefinition({
      registry,
      adapters: [createGoogleCastDeviceAdapter(provider)],
      capability: "announce",
    }),
  ];
}
